'use strict';
const { spawn } = require( 'child_process' );
const fs = require( 'fs' );
const { isDebugEnabled } = require( '../debug' );

const DEFAULT_BINARY = '/usr/local/bin/container';

// Gateway of Apple `container`'s default network, which is the macOS host as
// seen from a container.
const DEFAULT_HOST_GATEWAY = '192.168.64.1';

// How long a timed-out command's `onTimeout` cleanup may run before the
// process is killed regardless.
const ON_TIMEOUT_LIMIT_MS = 15 * 1000;

class ContainerCLIError extends Error {
	constructor( args, result ) {
		const detail = ( result.stderr || result.stdout || '' ).trim();
		super(
			`\`container ${ args.join( ' ' ) }\` failed (exit ${ result.exitCode })${
				detail ? `: ${ detail }` : ''
			}`
		);
		this.name = 'ContainerCLIError';
		this.exitCode = result.exitCode;
		this.stdout = result.stdout;
		this.stderr = result.stderr;
	}
}

/**
 * Thin wrapper over Apple's `container` CLI. Every call passes an argument
 * array; nothing goes through a shell.
 */
class ContainerCLI {
	/**
	 * @param {string}  [binaryPath]
	 * @param {Object}  [options]
	 * @param {boolean} [options.debug]  Write each command and its exit code to stderr.
	 * @param {Object}  [options.stderr] Writable for debug lines. Defaults to `process.stderr`.
	 */
	constructor(
		binaryPath = process.env.WP_ENV_CONTAINER_BIN || DEFAULT_BINARY,
		{ debug = isDebugEnabled(), stderr } = {}
	) {
		this.binaryPath = binaryPath;
		this.debug = debug;
		this.stderr = stderr;
	}

	debugLog( line ) {
		if ( this.debug ) {
			( this.stderr || process.stderr ).write( `${ line }\n` );
		}
	}

	isInstalled() {
		return fs.existsSync( this.binaryPath );
	}

	/**
	 * Runs `container <args>` and collects its output.
	 *
	 * @param {string[]}               args
	 * @param {Object}                 [options]
	 * @param {boolean}                [options.inherit]          Attach to the caller's stdio; output is captured otherwise.
	 * @param {number}                 [options.timeoutMs]        Kill the process after this long.
	 * @param {() => Promise<unknown>} [options.onTimeout]        Called before the process is killed on timeout.
	 * @param {number}                 [options.onTimeoutLimitMs] How long `onTimeout` may run before the kill.
	 * @return {Promise<{exitCode: number, stdout: string, stderr: string, timedOut: boolean}>} Exit code and captured output.
	 */
	exec(
		args,
		{
			inherit = false,
			timeoutMs,
			onTimeout,
			onTimeoutLimitMs = ON_TIMEOUT_LIMIT_MS,
		} = {}
	) {
		return new Promise( ( resolve, reject ) => {
			const startedAt = Date.now();
			this.debugLog( `$ container ${ args.join( ' ' ) }` );
			const child = spawn( this.binaryPath, args, {
				stdio: inherit ? 'inherit' : [ 'ignore', 'pipe', 'pipe' ],
			} );
			let stdout = '';
			let stderr = '';
			let timedOut = false;
			let timer;

			if ( ! inherit ) {
				child.stdout.on( 'data', ( chunk ) => ( stdout += chunk ) );
				child.stderr.on( 'data', ( chunk ) => ( stderr += chunk ) );
			}
			if ( timeoutMs ) {
				timer = setTimeout( async () => {
					timedOut = true;
					if ( onTimeout ) {
						let limitTimer;
						const limit = new Promise( ( resolveLimit ) => {
							limitTimer = setTimeout(
								resolveLimit,
								onTimeoutLimitMs
							);
						} );
						const cleanup = Promise.resolve()
							.then( onTimeout )
							.catch( () => {} );
						await Promise.race( [ cleanup, limit ] );
						clearTimeout( limitTimer );
					}
					child.kill( 'SIGTERM' );
				}, timeoutMs );
			}

			child.on( 'error', reject );
			child.on( 'close', ( code ) => {
				clearTimeout( timer );
				this.debugLog(
					`→ exit ${ code ?? 1 } (${ Date.now() - startedAt } ms)`
				);
				resolve( {
					exitCode: code ?? 1,
					stdout: stripProgress( stdout ),
					stderr: stripProgress( stderr ),
					timedOut,
				} );
			} );
		} );
	}

	/**
	 * Like `exec`, but throws a `ContainerCLIError` on a non-zero exit.
	 *
	 * @param {string[]} args
	 * @param {Object}   [options] See `exec`.
	 * @return {Promise<string>} stdout.
	 */
	async run( args, options ) {
		const result = await this.exec( args, options );
		if ( result.exitCode !== 0 ) {
			throw new ContainerCLIError( args, result );
		}
		return result.stdout;
	}

	async isSystemRunning() {
		const result = await this.exec( [ 'system', 'status' ] );
		return (
			result.exitCode === 0 && /status\s+running/.test( result.stdout )
		);
	}

	/**
	 * @return {Promise<Object[]>} Every container, running or stopped.
	 */
	async list() {
		const stdout = await this.run( [
			'list',
			'--all',
			'--format',
			'json',
		] );
		return JSON.parse( stdout || '[]' ).map( toRecord );
	}

	/**
	 * @param {Object<string, string>} labels Labels a container must carry.
	 * @return {Promise<Object[]>} Matching container records.
	 */
	async listByLabels( labels ) {
		const records = await this.list();
		return records.filter( ( record ) =>
			Object.entries( labels ).every(
				( [ key, value ] ) => record.labels[ key ] === value
			)
		);
	}

	/**
	 * @param {string} name
	 * @param {Object} [options]
	 * @param {number} [options.timeoutMs] Kill the `inspect` process after this long.
	 * @return {Promise<?Object>} The container, or null when it does not exist or the timeout passes.
	 */
	async inspect( name, { timeoutMs } = {} ) {
		const result = await this.exec( [ 'inspect', name ], { timeoutMs } );
		if ( result.exitCode !== 0 ) {
			return null;
		}
		const [ first ] = JSON.parse( result.stdout || '[]' );
		return first ? toRecord( first ) : null;
	}

	async imageExists( reference ) {
		const result = await this.exec( [ 'image', 'inspect', reference ] );
		return result.exitCode === 0;
	}

	/**
	 * @param {string} reference Image reference, e.g. `phpmyadmin`.
	 * @return {Promise<?string>} The digest the local tag currently points to, or null when the image or its digest is unavailable.
	 */
	async imageDigest( reference ) {
		const result = await this.exec( [ 'image', 'inspect', reference ] );
		if ( result.exitCode !== 0 ) {
			return null;
		}
		try {
			const [ first ] = JSON.parse( result.stdout || '[]' );
			return first?.configuration?.descriptor?.digest || null;
		} catch {
			return null;
		}
	}

	/**
	 * @return {Promise<string[]>} The name of every local image, e.g. `wordpress:php8.3`.
	 */
	async listImages() {
		const stdout = await this.run( [
			'image',
			'list',
			'--format',
			'json',
		] );
		return JSON.parse( stdout || '[]' )
			.map( ( image ) => image.configuration?.name )
			.filter( Boolean );
	}

	/**
	 * Reads the gateway of the default network, the address a container uses
	 * to reach the macOS host.
	 *
	 * @return {Promise<string>} The gateway IP, or `192.168.64.1` when the
	 *         network cannot be read.
	 */
	async hostGateway() {
		const result = await this.exec( [ 'network', 'inspect', 'default' ] );
		if ( result.exitCode !== 0 ) {
			return DEFAULT_HOST_GATEWAY;
		}
		try {
			const [ network ] = JSON.parse( result.stdout || '[]' );
			const gateway = network?.status?.ipv4Gateway;
			return gateway ? gateway.split( '/' )[ 0 ] : DEFAULT_HOST_GATEWAY;
		} catch {
			return DEFAULT_HOST_GATEWAY;
		}
	}
}

/**
 * Flattens `container inspect`/`list` JSON into the fields this tool uses.
 * `creationDate` and `startedDate` are present when the JSON has them; a
 * container that has not started yet has no `startedDate`.
 *
 * @param {Object} raw Parsed JSON for one container.
 * @return {{name: string, state: string, image: ?string, labels: Object, ipAddress: ?string, ports: Object[], environment: string[], creationDate?: string, startedDate?: string}} The container record.
 */
function toRecord( raw ) {
	const configuration = raw.configuration || {};
	const isStatusObject =
		Boolean( raw.status ) && typeof raw.status === 'object';
	const status = isStatusObject ? raw.status : {};
	const state = status.state || raw.status || 'unknown';
	const networks = status.networks || raw.networks || [];
	const address = networks[ 0 ]?.ipv4Address || null;

	return {
		name: configuration.id || raw.id,
		state,
		image: configuration.image?.reference || null,
		...( configuration.image?.descriptor?.digest && {
			imageDigest: configuration.image.descriptor.digest,
		} ),
		labels: configuration.labels || {},
		ipAddress: address ? address.split( '/' )[ 0 ] : null,
		ports: configuration.publishedPorts || [],
		environment: configuration.initProcess?.environment || [],
		...( configuration.creationDate && {
			creationDate: configuration.creationDate,
		} ),
		...( status.startedDate && { startedDate: status.startedDate } ),
	};
}

/**
 * Drops the `[n/6] Fetching image` progress lines `container run` prints.
 *
 * @param {string} text Command output.
 * @return {string} The output without progress lines.
 */
function stripProgress( text ) {
	return text
		.split( '\n' )
		.filter( ( line ) => ! /^\[\d+\/\d+\] /.test( line ) )
		.join( '\n' );
}

module.exports = {
	DEFAULT_HOST_GATEWAY,
	ContainerCLI,
	ContainerCLIError,
	stripProgress,
	toRecord,
};
