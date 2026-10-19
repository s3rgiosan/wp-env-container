'use strict';
const test = require( 'node:test' );
const assert = require( 'node:assert/strict' );
const { execFileSync } = require( 'child_process' );
const fs = require( 'fs' );
const path = require( 'path' );
const {
	collectSources,
	downloadSource,
	readWordPressVersion,
} = require( '../../lib/runtime/sources' );
const { makeConfig } = require( '../helpers/config' );
const { makeTempDir } = require( '../helpers/temp' );

function makeRepo() {
	const root = makeTempDir( 'wpec-sources-' );
	const repo = path.join( root, 'origin' );
	fs.mkdirSync( repo );
	const git = ( ...args ) =>
		execFileSync( 'git', args, { cwd: repo, stdio: 'ignore' } );
	git( 'init', '-q', '-b', 'trunk' );
	fs.writeFileSync( path.join( repo, 'plugin.php' ), '<?php // first' );
	git( 'add', '.' );
	git(
		'-c',
		'user.name=Test',
		'-c',
		'user.email=test@example.com',
		'commit',
		'-q',
		'-m',
		'one'
	);
	git( 'tag', '1.0.0' );
	fs.writeFileSync( path.join( repo, 'plugin.php' ), '<?php // second' );
	git(
		'-c',
		'user.name=Test',
		'-c',
		'user.email=test@example.com',
		'commit',
		'-q',
		'-am',
		'two'
	);
	return { root, url: `file://${ repo }` };
}

test( 'a git source checks out the requested ref', async () => {
	const { root, url } = makeRepo();
	const clonePath = path.join( root, 'checkout' );

	await downloadSource( {
		type: 'git',
		url,
		ref: '1.0.0',
		clonePath,
		path: clonePath,
	} );

	assert.equal(
		fs.readFileSync( path.join( clonePath, 'plugin.php' ), 'utf8' ),
		'<?php // first'
	);
} );

test( 'a partial folder from an interrupted clone is replaced', async () => {
	const { root, url } = makeRepo();
	const clonePath = path.join( root, 'checkout' );
	fs.mkdirSync( clonePath );
	fs.writeFileSync( path.join( clonePath, 'leftover' ), '' );

	await downloadSource( {
		type: 'git',
		url,
		ref: null,
		clonePath,
		path: clonePath,
	} );

	assert.equal(
		fs.readFileSync( path.join( clonePath, 'plugin.php' ), 'utf8' ),
		'<?php // second'
	);
	assert.equal( fs.existsSync( path.join( clonePath, 'leftover' ) ), false );
} );

test( 'a broken repository is cloned again', async () => {
	const { root, url } = makeRepo();
	const clonePath = path.join( root, 'checkout' );
	fs.mkdirSync( path.join( clonePath, '.git' ), { recursive: true } );

	await downloadSource( {
		type: 'git',
		url,
		ref: '1.0.0',
		clonePath,
		path: clonePath,
	} );

	assert.equal(
		fs.readFileSync( path.join( clonePath, 'plugin.php' ), 'utf8' ),
		'<?php // first'
	);
} );

test( 'without a ref, every run checks out the default branch', async () => {
	const root = makeTempDir( 'wpec-sources-' );
	const repo = path.join( root, 'origin' );
	fs.mkdirSync( repo );
	const git = ( ...args ) =>
		execFileSync( 'git', args, { cwd: repo, stdio: 'ignore' } );
	const commit = ( message ) =>
		git(
			'-c',
			'user.name=Test',
			'-c',
			'user.email=test@example.com',
			'commit',
			'-q',
			'-am',
			message
		);
	git( 'init', '-q', '-b', 'main' );
	fs.writeFileSync( path.join( repo, 'plugin.php' ), '<?php // main' );
	git( 'add', '.' );
	commit( 'main' );
	git( 'checkout', '-q', '-b', '1.x' );
	fs.writeFileSync( path.join( repo, 'plugin.php' ), '<?php // 1.x' );
	commit( '1.x' );
	git( 'checkout', '-q', 'main' );
	const mainCommit = execFileSync( 'git', [ 'rev-parse', 'main' ], {
		cwd: repo,
		encoding: 'utf8',
	} ).trim();
	const clonePath = path.join( root, 'checkout' );
	const source = {
		type: 'git',
		url: `file://${ repo }`,
		ref: null,
		clonePath,
		path: clonePath,
	};
	const checkedOut = () =>
		execFileSync( 'git', [ 'rev-parse', 'HEAD' ], {
			cwd: clonePath,
			encoding: 'utf8',
		} ).trim();

	await downloadSource( source );
	assert.equal( checkedOut(), mainCommit );

	await downloadSource( source );
	assert.equal( checkedOut(), mainCommit );
} );

test( 'collectSources skips local sources and dedupes shared ones', () => {
	const config = makeConfig();

	const sources = collectSources( config );

	assert.equal( sources.length, 1 );
	assert.equal( sources[ 0 ].path, '/state/example-project/WordPress' );
} );

test( 'collectSources downloads each git clone folder once', () => {
	const config = makeConfig();
	const monorepo = {
		type: 'git',
		url: 'https://github.com/example/monorepo.git',
		ref: undefined,
		clonePath: '/state/example-project/monorepo',
	};
	config.env.development.pluginSources = [
		{
			...monorepo,
			path: '/state/example-project/monorepo/plugins/one',
			basename: 'one',
		},
		{
			...monorepo,
			path: '/state/example-project/monorepo/plugins/two',
			basename: 'two',
		},
	];
	config.env.tests.pluginSources = config.env.development.pluginSources;

	const clonePaths = collectSources( config )
		.filter( ( source ) => source.type === 'git' )
		.map( ( source ) => source.clonePath );

	assert.deepEqual( clonePaths, [
		'/state/example-project/WordPress',
		'/state/example-project/monorepo',
	] );
} );

test( 'readWordPressVersion reads wp-includes/version.php', async () => {
	const core = makeTempDir( 'wpec-core-' );
	fs.mkdirSync( path.join( core, 'wp-includes' ) );
	fs.writeFileSync(
		path.join( core, 'wp-includes', 'version.php' ),
		"<?php\n$wp_version = '6.0.1';\n"
	);

	assert.equal( await readWordPressVersion( core ), '6.0.1' );
	assert.equal(
		await readWordPressVersion( path.join( core, 'missing' ) ),
		null
	);
} );

test( 'collectSources rejects two different git sources with one clone folder', () => {
	const clonePath = '/state/example-project/gutenberg';
	const source = ( url, ref ) => ( {
		type: 'git',
		url,
		ref,
		clonePath,
		path: clonePath,
		basename: 'gutenberg',
	} );

	const differentRef = makeConfig();
	differentRef.env.development.pluginSources = [
		source( 'https://github.com/example/gutenberg.git', 'v1' ),
	];
	differentRef.env.tests.pluginSources = [
		source( 'https://github.com/example/gutenberg.git', 'v2' ),
	];
	assert.throws( () => collectSources( differentRef ), {
		message:
			'Two git sources clone into /state/example-project/gutenberg: https://github.com/example/gutenberg.git#v1 and https://github.com/example/gutenberg.git#v2. Give them different repository names.',
	} );

	const differentOwner = makeConfig();
	differentOwner.env.development.pluginSources = [
		source( 'https://github.com/a/gutenberg.git', 'v1' ),
		source( 'https://github.com/b/gutenberg.git', 'v1' ),
	];
	assert.throws(
		() => collectSources( differentOwner ),
		/Two git sources clone into/
	);
} );

test( 'collectSources dedupes git sources with the same url and ref', () => {
	const clonePath = '/state/example-project/gutenberg';
	const source = {
		type: 'git',
		url: 'https://github.com/example/gutenberg.git',
		ref: 'v1',
		clonePath,
		path: clonePath,
	};
	const config = makeConfig();
	config.env.development.pluginSources = [ source ];
	config.env.tests.pluginSources = [ { ...source } ];

	const clones = collectSources( config ).filter(
		( item ) => item.clonePath === clonePath
	);

	assert.equal( clones.length, 1 );
} );
