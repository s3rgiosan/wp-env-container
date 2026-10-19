<?php
/**
 * Loads the WordPress test library with the sample plugin active.
 */

$tests_dir = getenv( 'WP_TESTS_DIR' );

require_once dirname( __DIR__ ) . '/vendor/yoast/phpunit-polyfills/phpunitpolyfills-autoload.php';
require_once $tests_dir . '/includes/functions.php';

tests_add_filter(
	'muplugins_loaded',
	function () {
		require dirname( __DIR__ ) . '/sample-plugin.php';
	}
);

require $tests_dir . '/includes/bootstrap.php';
