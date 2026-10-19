import wordpress from '@wordpress/eslint-plugin';
import globals from 'globals';

export default [
	{
		ignores: [ 'test/fixtures/**' ],
	},
	...wordpress.configs.recommended,
	{
		files: [ '**/*.js', 'bin/wp-env-container' ],
		languageOptions: {
			sourceType: 'commonjs',
			globals: globals.node,
		},
	},
];
