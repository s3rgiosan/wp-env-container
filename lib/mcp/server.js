'use strict';
const { McpServer } = require( '@modelcontextprotocol/sdk/server/mcp.js' );
const {
	StdioServerTransport,
} = require( '@modelcontextprotocol/sdk/server/stdio.js' );
const { z } = require( 'zod' );
const { loadProjectConfig } = require( '../config' );
const { AppleContainerRuntime } = require( '../runtime/apple-container' );
const { parseXdebugMode } = require( '../runtime/recipes' );
const { version } = require( '../../package.json' );

function textResult( value, isError = false ) {
	const isText = typeof value === 'string';
	const text = isText ? value : JSON.stringify( value, null, 2 );
	return { content: [ { type: 'text', text } ], isError };
}

const TESTS_DISABLED_MESSAGE =
	'The tests environment is disabled ("testsEnvironment": false in .wp-env.json).';

/**
 * Error result for a project without a tests environment, or null when the
 * tests environment is configured.
 *
 * @param {Object} config Project config.
 * @return {?Object} An `isError` result, or null.
 */
function testsDisabledResult( config ) {
	return config.testsEnvironment === false
		? textResult( TESTS_DISABLED_MESSAGE, true )
		: null;
}

/**
 * Wraps a tool handler so a thrown error becomes an `isError` result the
 * agent can read, never a protocol failure.
 *
 * @param {(input: Object) => unknown} handler Tool implementation.
 * @return {(input: ?Object) => Promise<Object>} Tool callback for the MCP server.
 */
function tool( handler ) {
	return async ( input ) => {
		try {
			return await handler( input || {} );
		} catch ( error ) {
			return textResult( error.message, true );
		}
	};
}

/**
 * Builds the MCP server. The config is reloaded on every call so edits to
 * `.wp-env.json` apply without restarting the server.
 *
 * @param {Object}                options
 * @param {Object}                options.runtime   An `AppleContainerRuntime` (or a test double).
 * @param {() => Promise<Object>} options.getConfig Returns a promise of the project config.
 * @return {McpServer} The configured server.
 */
function createServer( { runtime, getConfig } ) {
	const server = new McpServer( { name: 'wp-env-container', version } );

	server.registerTool(
		'tests_status',
		{
			title: 'Tests environment status',
			description:
				'Whether the tests environment (WordPress plus its database) is running, with its URL, port, container name, WordPress and PHP versions and Xdebug modes (off when not loaded), plus the tests database state, container, host, port and image, and the tests phpMyAdmin state, container, URL and port (null when "phpmyadmin" is off).',
			annotations: { readOnlyHint: true },
		},
		tool( async () => {
			const config = await getConfig();
			const disabled = testsDisabledResult( config );
			if ( disabled ) {
				return disabled;
			}
			const status = await runtime.getStatus( config );
			if ( ! status.environments.tests ) {
				return textResult( TESTS_DISABLED_MESSAGE, true );
			}
			const { database, phpmyadmin, ...tests } =
				status.environments.tests;
			return textResult(
				{
					projectId: status.projectId,
					database,
					phpmyadmin,
					tests,
				},
				! tests.running
			);
		} )
	);

	server.registerTool(
		'tests_logs',
		{
			title: 'Tests environment logs',
			description:
				'Recent log lines from the tests environment: "apache" is the WordPress container output (access log and PHP errors), "debug_log" is wp-content/debug.log.',
			inputSchema: {
				source: z.enum( [ 'apache', 'debug_log' ] ).default( 'apache' ),
				lines: z.number().int().min( 1 ).max( 2000 ).default( 100 ),
			},
			annotations: { readOnlyHint: true },
		},
		tool( async ( { source, lines } ) => {
			const text = await runtime.readLogs( await getConfig(), 'tests', {
				source,
				lines,
			} );
			return textResult( text || '(no output)' );
		} )
	);

	server.registerTool(
		'tests_wp_cli',
		{
			title: 'wp-cli on the tests site',
			description:
				'Runs a wp-cli command against the tests site. Pass the arguments after `wp` as an array, e.g. ["option", "get", "siteurl"]. No shell is involved.',
			inputSchema: {
				args: z.array( z.string() ).min( 1 ),
				cwd: z
					.string()
					.optional()
					.describe(
						'Working directory relative to the WordPress root, e.g. wp-content/plugins/my-plugin.'
					),
				timeoutSeconds: z
					.number()
					.int()
					.min( 1 )
					.max( 3600 )
					.default( 300 ),
			},
		},
		tool( async ( { args, cwd, timeoutSeconds } ) => {
			const result = await runtime.wpCli(
				await getConfig(),
				'tests',
				args,
				{
					cwd,
					timeoutMs: timeoutSeconds * 1000,
				}
			);
			const failed = result.exitCode !== 0 || Boolean( result.timedOut );
			return textResult( result, failed );
		} )
	);

	server.registerTool(
		'tests_phpunit',
		{
			title: 'Run PHPUnit',
			description:
				"Runs PHPUnit in the tests environment for a plugin or theme (default: the first plugin in .wp-env.json). Uses the project's vendor/bin/phpunit when present, otherwise the PHPUnit bundled in the CLI image. Returns pass/fail, counts, failed tests with messages and the tail of the output.",
			inputSchema: {
				path: z
					.string()
					.optional()
					.describe(
						'Directory relative to the WordPress root, e.g. wp-content/plugins/my-plugin.'
					),
				filter: z.string().optional().describe( 'Value for --filter.' ),
				testsuite: z
					.string()
					.optional()
					.describe( 'Value for --testsuite.' ),
				configuration: z
					.string()
					.optional()
					.describe( 'Value for --configuration, relative to path.' ),
				extraArgs: z
					.array( z.string() )
					.default( [] )
					.describe( 'Further PHPUnit arguments.' ),
				timeoutSeconds: z
					.number()
					.int()
					.min( 10 )
					.max( 3600 )
					.default( 600 ),
				xdebug: z
					.string()
					.optional()
					.describe(
						'Xdebug modes, e.g. debug or coverage. Step debugging needs an IDE listening on port 9003.'
					),
			},
		},
		tool( async ( { timeoutSeconds, xdebug, ...options } ) => {
			if ( xdebug !== undefined ) {
				options.xdebug = parseXdebugMode( xdebug );
			}
			const result = await runtime.phpunit( await getConfig(), {
				...options,
				timeoutMs: timeoutSeconds * 1000,
			} );
			return textResult( result, ! result.passed );
		} )
	);

	server.registerTool(
		'tests_reset',
		{
			title: 'Reset the tests site',
			description:
				'Empties the tests database and reinstalls WordPress with the .wp-env.json settings and plugins. The development site is not touched.',
			annotations: { destructiveHint: true, idempotentHint: true },
		},
		tool( async () => {
			const config = await getConfig();
			const disabled = testsDisabledResult( config );
			if ( disabled ) {
				return disabled;
			}
			await runtime.clean( config, { environment: 'tests' } );
			return textResult( 'The tests site was reset and reinstalled.' );
		} )
	);

	return server;
}

/**
 * Serves the tools over stdio for the project in the current directory.
 * Progress messages go to stderr, which stdio MCP clients keep apart from
 * the protocol stream.
 *
 * The config loads on the first tool call: wp-env's loader asks
 * api.wordpress.org for the latest WordPress version, which must not hold up
 * the MCP handshake.
 *
 * @param {Object}  [options]
 * @param {?string} [options.customConfigPath] Path to a custom `.wp-env.json`.
 */
async function startServer( { customConfigPath = null } = {} ) {
	const runtime = new AppleContainerRuntime();
	const getConfig = () => loadProjectConfig( { customConfigPath } );
	const server = createServer( { runtime, getConfig } );
	await server.connect( new StdioServerTransport() );
}

module.exports = {
	createServer,
	startServer,
};
