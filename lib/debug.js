'use strict';

const OFF_VALUES = [ '', '0', 'false', 'no', 'off' ];

/**
 * @param {string} [value] Defaults to `WP_ENV_CONTAINER_DEBUG`.
 * @return {boolean} Whether debug output is on: any value except empty, `0`,
 *         `false`, `no` and `off` (case-insensitive).
 */
function isDebugEnabled( value = process.env.WP_ENV_CONTAINER_DEBUG ) {
	const normalized = String( value ?? '' )
		.trim()
		.toLowerCase();
	return ! OFF_VALUES.includes( normalized );
}

module.exports = { isDebugEnabled };
