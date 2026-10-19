'use strict';
/**
 * A project config shaped like `loadProjectConfig` output, built by hand so
 * unit tests need no network or `.wp-env.json`.
 *
 * @param {Object} overrides Values merged over the default config.
 * @return {Object} The config.
 */
function makeConfig( overrides = {} ) {
	const state = '/state/example-project';
	const coreSource = {
		type: 'git',
		url: 'https://github.com/WordPress/WordPress.git',
		ref: '6.0.0',
		path: `${ state }/WordPress`,
		clonePath: `${ state }/WordPress`,
		basename: 'WordPress',
		testsPath: `${ state }/tests-WordPress`,
	};
	const plugin = {
		type: 'local',
		path: '/projects/example-plugin',
		basename: 'example-plugin',
	};
	const environment = ( port, extra = {} ) => ( {
		mysqlPort: null,
		multisite: false,
		phpVersion: null,
		mariadbVersion: null,
		coreSource,
		pluginSources: [ plugin ],
		themeSources: [],
		mappings: {},
		port,
		config: {
			WP_DEBUG: true,
			WP_SITEURL: `http://localhost:${ port }`,
			WP_HOME: `http://localhost:${ port }`,
		},
		...extra,
	} );

	return {
		name: 'example-plugin',
		projectId: 'example-project',
		stateDirectoryPath: state,
		configDirectoryPath: '/projects/example-plugin',
		testsEnvironment: true,
		mariadbImage: 'mariadb:lts',
		lifecycleScripts: {},
		env: {
			development: environment( 8888 ),
			tests: environment( 8889 ),
		},
		...overrides,
	};
}

module.exports = { makeConfig };
