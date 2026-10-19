'use strict';
const { execFile } = require( 'child_process' );
const fs = require( 'fs' );
const os = require( 'os' );
const path = require( 'path' );
const { promisify } = require( 'util' );
const { Readable } = require( 'stream' );
const { pipeline } = require( 'stream/promises' );
const { isDebugEnabled } = require( '../debug' );

const execFileAsync = promisify( execFile );

const GIT_ATTEMPTS = 3;

// Each git command is killed after this long. Normal clones and fetches here
// take seconds; a stalled connection would otherwise block forever.
const GIT_TIMEOUT_MS = 5 * 60 * 1000;

// A transfer slower than 1 KB/s for 30 s is aborted by git itself.
const GIT_STALL_OPTIONS = [
	'-c',
	'http.lowSpeedLimit=1000',
	'-c',
	'http.lowSpeedTime=30',
];

/**
 * Runs git, retrying a few times: blob-less clones fetch file contents lazily
 * at checkout, so a dropped or stalled connection can fail any step.
 *
 * @param {string[]}            args
 * @param {?string}             cwd
 * @param {Object}              [options]
 * @param {() => Promise<void>} [options.beforeRetry] Cleans up after a failed attempt.
 */
async function git( args, cwd, { beforeRetry } = {} ) {
	for ( let attempt = 1; ; attempt++ ) {
		if ( isDebugEnabled() ) {
			process.stderr.write( `$ git ${ args.join( ' ' ) }\n` );
		}
		try {
			await execFileAsync( 'git', [ ...GIT_STALL_OPTIONS, ...args ], {
				cwd,
				maxBuffer: 64 * 1024 * 1024,
				timeout: GIT_TIMEOUT_MS,
				killSignal: 'SIGKILL',
			} );
			return;
		} catch ( error ) {
			if ( attempt >= GIT_ATTEMPTS ) {
				throw error;
			}
			if ( beforeRetry ) {
				await beforeRetry();
			}
			await new Promise( ( resolve ) =>
				setTimeout( resolve, attempt * 2000 )
			);
		}
	}
}

/**
 * Clones into `directory`, removing any partial checkout a failed attempt
 * left behind so the next attempt starts clean.
 *
 * @param {string[]} flags
 * @param {string}   url
 * @param {string}   directory
 */
async function clone( flags, url, directory ) {
	const removePartial = () =>
		fs.promises.rm( directory, { recursive: true, force: true } );
	await removePartial();
	await fs.promises.mkdir( path.dirname( directory ), { recursive: true } );
	await git( [ 'clone', ...flags, url, directory ], null, {
		beforeRetry: removePartial,
	} );
}

function isGitRepo( directory ) {
	return fs.existsSync( path.join( directory, '.git' ) );
}

/**
 * Shallow, blob-less clone of `source.url`, then checks out `source.ref`
 * (or the default branch when there is none).
 *
 * @param {{url: string, ref: ?string, clonePath: string}} source
 */
async function downloadGitSource( source ) {
	const cloneSource = () =>
		clone(
			[ '--depth', '1', '--filter', 'blob:none', '--no-single-branch' ],
			source.url,
			source.clonePath
		);
	const checkoutRef = async () => {
		// Fetching the remote HEAD keeps FETCH_HEAD on the default branch when
		// the local checkout is detached.
		const fetchArgs = [
			'fetch',
			'--tags',
			'--depth',
			'1',
			'origin',
			source.ref || 'HEAD',
		];
		await git( fetchArgs, source.clonePath );
		await git( [ 'checkout', '--force', 'FETCH_HEAD' ], source.clonePath );
	};

	if ( ! isGitRepo( source.clonePath ) ) {
		await cloneSource();
		await checkoutRef();
		return;
	}
	try {
		await checkoutRef();
	} catch {
		// An interrupted earlier clone can leave a repository git cannot use.
		await cloneSource();
		await checkoutRef();
	}
}

/**
 * Downloads and extracts a zip source into `source.path`. A zip whose only
 * entry is a folder is unwrapped.
 *
 * @param {{url: string, path: string}} source
 */
async function downloadZipSource( source ) {
	const temp = await fs.promises.mkdtemp(
		path.join( os.tmpdir(), 'wp-env-container-' )
	);
	try {
		const zipPath = path.join( temp, 'source.zip' );
		const response = await fetch( source.url );
		if ( ! response.ok ) {
			throw new Error(
				`Download of ${ source.url } failed: HTTP ${ response.status }`
			);
		}
		await pipeline(
			Readable.fromWeb( response.body ),
			fs.createWriteStream( zipPath )
		);

		const extracted = path.join( temp, 'extracted' );
		await execFileAsync( 'unzip', [ '-q', zipPath, '-d', extracted ] );
		const entries = await fs.promises.readdir( extracted );
		let root = extracted;
		if ( entries.length === 1 ) {
			const only = path.join( extracted, entries[ 0 ] );
			const stat = await fs.promises.lstat( only );
			root = stat.isDirectory() ? only : extracted;
		}

		await fs.promises.rm( source.path, { recursive: true, force: true } );
		await fs.promises.mkdir( path.dirname( source.path ), {
			recursive: true,
		} );
		await fs.promises.rename( root, source.path );
	} finally {
		await fs.promises.rm( temp, { recursive: true, force: true } );
	}
}

/**
 * @param {Object} source A wp-env source object.
 */
async function downloadSource( source ) {
	switch ( source.type ) {
		case 'git':
			await downloadGitSource( source );
			break;
		case 'zip':
			await downloadZipSource( source );
			break;
		default:
			break;
	}
}

/**
 * Every source of every enabled environment that needs downloading, one per
 * download destination: the clone folder for git sources, so several plugins
 * from one repository share a single clone, and the path for the rest.
 *
 * @param {Object} config Project configuration.
 * @return {Object[]} Sources to download.
 */
function collectSources( config ) {
	const environments = config.testsEnvironment
		? [ 'development', 'tests' ]
		: [ 'development' ];
	const byDestination = new Map();
	for ( const env of environments ) {
		const envConfig = config.env[ env ];
		const sources = [
			envConfig.coreSource,
			...envConfig.pluginSources,
			...envConfig.themeSources,
			...Object.values( envConfig.mappings ),
		];
		for ( const source of sources ) {
			if ( ! source || source.type === 'local' ) {
				continue;
			}
			const destination =
				source.type === 'git' ? source.clonePath : source.path;
			const existing = byDestination.get( destination );
			if ( ! existing ) {
				byDestination.set( destination, source );
				continue;
			}
			const isConflict =
				source.type === 'git' &&
				existing.type === 'git' &&
				( existing.url !== source.url ||
					( existing.ref ?? null ) !== ( source.ref ?? null ) );
			if ( isConflict ) {
				throw new Error(
					`Two git sources clone into ${ destination }: ${ existing.url }#${ existing.ref } and ${ source.url }#${ source.ref }. Give them different repository names.`
				);
			}
		}
	}
	return [ ...byDestination.values() ];
}

async function downloadSources( config ) {
	await Promise.all( collectSources( config ).map( downloadSource ) );
}

/**
 * Copies a core checkout to the tests core folder, leaving out what must stay
 * per-install (wp-config.php) and what WordPress never needs.
 *
 * @param {string} from
 * @param {string} to
 */
async function copyCore( from, to ) {
	await fs.promises.mkdir( to, { recursive: true } );
	await execFileAsync( 'rsync', [
		'-a',
		'--no-links',
		'--exclude',
		'.git',
		'--exclude',
		'node_modules',
		'--exclude',
		'/wp-config.php',
		`${ from }/`,
		`${ to }/`,
	] );
}

/**
 * @param {string} corePath
 * @return {Promise<?string>} The WordPress version in `corePath`, or null.
 */
async function readWordPressVersion( corePath ) {
	try {
		const contents = await fs.promises.readFile(
			path.join( corePath, 'wp-includes', 'version.php' ),
			'utf8'
		);
		const match = contents.match( /\$wp_version = '([A-Za-z\-0-9.]+)'/ );
		return match ? match[ 1 ] : null;
	} catch {
		return null;
	}
}

/**
 * Sparse checkout of `tests/phpunit` from wordpress-develop at the tag that
 * matches `wpVersion`, or trunk for pre-releases and unknown versions.
 *
 * @param {string}  directory
 * @param {?string} wpVersion
 */
async function downloadPHPUnitSuite( directory, wpVersion ) {
	if ( ! isGitRepo( directory ) ) {
		await clone(
			[ '--depth', '1', '--filter', 'blob:none', '--no-checkout' ],
			'https://github.com/WordPress/wordpress-develop.git',
			directory
		);
		await git(
			[ 'sparse-checkout', 'set', '--cone', 'tests/phpunit' ],
			directory
		);
	}

	let version = wpVersion;
	if ( version && /^[0-9]+\.[0-9]+$/.test( version ) ) {
		version += '.0';
	}
	const isRelease = version && ! /-(?:alpha|beta|rc)/i.test( version );
	if ( isRelease ) {
		await git(
			[ 'fetch', 'origin', 'tag', version, '--depth', '1' ],
			directory
		);
		await git( [ 'checkout', '--force', `tags/${ version }` ], directory );
	} else {
		await git( [ 'fetch', 'origin', 'trunk', '--depth', '1' ], directory );
		await git( [ 'checkout', '--force', 'FETCH_HEAD' ], directory );
	}
}

module.exports = {
	collectSources,
	copyCore,
	downloadPHPUnitSuite,
	downloadSource,
	downloadSources,
	readWordPressVersion,
};
