'use strict';

const NAMED_ENTITIES = {
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	amp: '&',
};

/**
 * Decodes XML entities in a single pass, so `&amp;#65;` becomes `&#65;`.
 * Numeric references to invalid code points stay as written.
 *
 * @param {string} text Text containing XML entities.
 * @return {string} The decoded text.
 */
function decode( text ) {
	return text.replace(
		/&(?:(lt|gt|quot|apos|amp)|#(\d+)|#x([0-9a-f]+));/gi,
		( entity, name, decimal, hex ) => {
			if ( name ) {
				return NAMED_ENTITIES[ name.toLowerCase() ] ?? entity;
			}
			const codePoint = decimal ? Number( decimal ) : parseInt( hex, 16 );
			const isValid =
				Number.isInteger( codePoint ) && codePoint <= 0x10ffff;
			return isValid ? String.fromCodePoint( codePoint ) : entity;
		}
	);
}

function attributes( tag ) {
	const result = {};
	for ( const match of tag.matchAll( /([\w:-]+)="([^"]*)"/g ) ) {
		result[ match[ 1 ] ] = decode( match[ 2 ] );
	}
	return result;
}

/**
 * Summarises a PHPUnit JUnit report: totals from the outermost
 * `<testsuite>`, plus every test case that failed, errored or warned.
 *
 * @param {string} xml JUnit XML report.
 * @return {{tests: number, assertions: number, failures: number, errors: number, skipped: number, warnings: number, time: number, failed: Object[]}} Report totals and the failed test cases.
 */
function parseJUnit( xml ) {
	const suiteTag = xml.match( /<testsuite\b[^>]*>/ );
	const suite = suiteTag ? attributes( suiteTag[ 0 ] ) : {};
	const failed = [];

	const caseRegex = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
	for ( const match of xml.matchAll( caseRegex ) ) {
		const body = match[ 2 ] || '';
		const problem = body.match(
			/<(failure|error|warning)\b([^>]*)>([\s\S]*?)<\/\1>/
		);
		if ( ! problem ) {
			continue;
		}
		const testCase = attributes( match[ 1 ] );
		const problemAttributes = attributes( problem[ 2 ] );
		failed.push( {
			name: testCase.name,
			class: testCase.class || testCase.classname || null,
			file: testCase.file || null,
			line: testCase.line ? Number( testCase.line ) : null,
			kind: problem[ 1 ],
			type: problemAttributes.type || null,
			message: decode( problem[ 3 ] ).trim(),
		} );
	}

	return {
		tests: Number( suite.tests || 0 ),
		assertions: Number( suite.assertions || 0 ),
		failures: Number( suite.failures || 0 ),
		errors: Number( suite.errors || 0 ),
		skipped: Number( suite.skipped || 0 ),
		warnings: Number( suite.warnings || 0 ),
		time: Number( suite.time || 0 ),
		failed,
	};
}

module.exports = { parseJUnit };
