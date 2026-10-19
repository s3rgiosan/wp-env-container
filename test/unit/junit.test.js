'use strict';
const test = require( 'node:test' );
const assert = require( 'node:assert/strict' );
const { parseJUnit } = require( '../../lib/junit' );

const REPORT = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="default" tests="3" assertions="4" errors="1" failures="1" skipped="0" time="0.25">
    <testsuite name="Example_Test" tests="3" assertions="4" errors="1" failures="1" skipped="0" time="0.25">
      <testcase name="test_passes" class="Example_Test" file="/var/www/html/tests/Example_Test.php" line="10" assertions="2" time="0.01"/>
      <testcase name="test_fails" class="Example_Test" file="/var/www/html/tests/Example_Test.php" line="20" assertions="2" time="0.01">
        <failure type="PHPUnit\\Framework\\ExpectationFailedException">Failed asserting that 1 &lt; 0 &amp; more.</failure>
      </testcase>
      <testcase name="test_errors" class="Example_Test" file="/var/www/html/tests/Example_Test.php" line="30" assertions="0" time="0.01">
        <error type="Error">Call to undefined function example()</error>
      </testcase>
    </testsuite>
  </testsuite>
</testsuites>`;

test( 'parseJUnit reads totals from the outermost suite', () => {
	const summary = parseJUnit( REPORT );

	assert.equal( summary.tests, 3 );
	assert.equal( summary.assertions, 4 );
	assert.equal( summary.failures, 1 );
	assert.equal( summary.errors, 1 );
	assert.equal( summary.skipped, 0 );
	assert.equal( summary.warnings, 0 );
	assert.equal( summary.time, 0.25 );
} );

test( 'parseJUnit lists failed and errored cases with decoded messages', () => {
	const { failed } = parseJUnit( REPORT );

	assert.equal( failed.length, 2 );
	assert.deepEqual( failed[ 0 ], {
		name: 'test_fails',
		class: 'Example_Test',
		file: '/var/www/html/tests/Example_Test.php',
		line: 20,
		kind: 'failure',
		type: 'PHPUnit\\Framework\\ExpectationFailedException',
		message: 'Failed asserting that 1 < 0 & more.',
	} );
	assert.equal( failed[ 1 ].kind, 'error' );
	assert.equal( failed[ 1 ].message, 'Call to undefined function example()' );
} );

test( 'parseJUnit handles an empty report', () => {
	assert.deepEqual( parseJUnit( '<testsuites/>' ), {
		tests: 0,
		assertions: 0,
		failures: 0,
		errors: 0,
		skipped: 0,
		warnings: 0,
		time: 0,
		failed: [],
	} );
} );

test( 'parseJUnit decodes entities in a single pass', () => {
	const xml = `<testsuite tests="1"><testcase name="t" class="C"><failure type="E">Got &amp;#65; and &#65; and &#x41; and &lt;b&gt;</failure></testcase></testsuite>`;

	assert.equal(
		parseJUnit( xml ).failed[ 0 ].message,
		'Got &#65; and A and A and <b>'
	);
} );

test( 'parseJUnit leaves invalid numeric entities as written', () => {
	const xml = `<testsuite tests="1"><testcase name="t"><error type="E">Bad &#99999999; and &#xFFFFFFFF;</error></testcase></testsuite>`;

	assert.equal(
		parseJUnit( xml ).failed[ 0 ].message,
		'Bad &#99999999; and &#xFFFFFFFF;'
	);
} );

test( 'parseJUnit leaves skipped cases out of failed', () => {
	const xml = `<testsuite tests="2" skipped="1" time="1.5"><testcase name="a" class="C"><skipped/></testcase><testcase name="b" class="C"/></testsuite>`;
	const summary = parseJUnit( xml );

	assert.deepEqual( summary.failed, [] );
	assert.equal( summary.skipped, 1 );
	assert.equal( summary.time, 1.5 );
} );

test( 'parseJUnit lists warning cases and counts warnings', () => {
	const xml = `<testsuite tests="1" warnings="1"><testcase name="w" class="C" line="5"><warning type="PHPUnit\\Warning">Careful</warning></testcase></testsuite>`;
	const summary = parseJUnit( xml );

	assert.equal( summary.warnings, 1 );
	assert.equal( summary.failed.length, 1 );
	assert.equal( summary.failed[ 0 ].kind, 'warning' );
	assert.equal( summary.failed[ 0 ].message, 'Careful' );
} );

test( 'parseJUnit returns zero totals when there is no testsuite', () => {
	const summary = parseJUnit( '<foo/>' );

	assert.equal( summary.tests, 0 );
	assert.deepEqual( summary.failed, [] );
} );
