<?php
/**
 * Tests for the sample plugin.
 */

class SampleTest extends WP_UnitTestCase {

	public function test_answer() {
		$this->assertSame( 42, sample_plugin_answer() );
	}

	public function test_plugin_is_loaded() {
		$this->assertTrue( function_exists( 'sample_plugin_answer' ) );
	}
}
