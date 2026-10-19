'use strict';
const crypto = require( 'crypto' );
const fs = require( 'fs' );
const path = require( 'path' );

const POLL_MS = 250;

// The lock file exists for a moment before its pid is written. A file still
// without a pid after this long was left behind by a crashed process.
const EMPTY_LOCK_STALE_MS = 10 * 1000;

function isProcessAlive( pid ) {
	try {
		process.kill( pid, 0 );
		return true;
	} catch ( error ) {
		return error.code === 'EPERM';
	}
}

/**
 * @param {string} lockPath
 * @return {Promise<?{pid: ?number, ageMs: number}>} The holder's pid (null when
 *         unreadable) and the lock file's age, or null when there is no lock file.
 */
async function readLockHolder( lockPath ) {
	try {
		const stat = await fs.promises.stat( lockPath );
		const contents = await fs.promises.readFile( lockPath, 'utf8' );
		const pid = Number.parseInt( contents.trim(), 10 );
		return {
			pid: pid > 0 ? pid : null,
			ageMs: Date.now() - stat.mtimeMs,
			ino: stat.ino,
		};
	} catch ( error ) {
		if ( error.code === 'ENOENT' ) {
			return null;
		}
		throw error;
	}
}

/**
 * @param {{pid: ?number, ageMs: number, ino: number}} holder
 * @return {boolean} Whether the lock was left by a process that is gone.
 */
function isStale( holder ) {
	if ( holder.pid ) {
		return ! isProcessAlive( holder.pid );
	}
	return holder.ageMs > EMPTY_LOCK_STALE_MS;
}

/**
 * Removes a stale lock by renaming it aside. When the renamed file is not the
 * stale one that was inspected, another waiter already replaced it with a
 * live lock, so that file is put back.
 *
 * @param {string}        lockPath
 * @param {{ino: number}} stale    The lock file that was found stale.
 */
async function takeOverStaleLock( lockPath, stale ) {
	const asidePath = `${ lockPath }.stale-${ process.pid }-${ crypto.randomBytes( 4 ).toString( 'hex' ) }`;
	try {
		await fs.promises.rename( lockPath, asidePath );
	} catch ( error ) {
		if ( error.code === 'ENOENT' ) {
			return;
		}
		throw error;
	}
	const moved = await fs.promises.stat( asidePath );
	const isStaleFile = moved.ino === stale.ino;
	if ( ! isStaleFile ) {
		await fs.promises.link( asidePath, lockPath ).catch( ( error ) => {
			if ( error.code !== 'EEXIST' ) {
				throw error;
			}
		} );
	}
	await fs.promises.rm( asidePath, { force: true } );
}

/**
 * Runs `task` while holding an exclusive lock file in `directory`, so the CLI
 * and the MCP server never start, reset or destroy the same project at once.
 * A lock left by a dead process, or an empty lock file older than 10 s, is
 * taken over. When the directory disappears while waiting, it is created
 * again. On release the lock file is removed only while it is still this
 * call's own, so a task that deletes the directory leaves a later holder's
 * lock alone.
 *
 * @param {string}                 directory           Directory holding the lock file.
 * @param {() => Promise<unknown>} task                Work to run while the lock is held.
 * @param {Object}                 [options]
 * @param {number}                 [options.timeoutMs] How long to wait for another holder.
 * @return {Promise<unknown>} The task's result.
 */
async function withLock(
	directory,
	task,
	{ timeoutMs = 10 * 60 * 1000 } = {}
) {
	await fs.promises.mkdir( directory, { recursive: true } );
	const lockPath = path.join( directory, '.lock' );
	const deadline = Date.now() + timeoutMs;
	// The pid comes first, so `readLockHolder` reads it; the token tells this
	// call's lock file from a later one written by the same process.
	const contents = `${ process.pid } ${ crypto.randomBytes( 8 ).toString( 'hex' ) }`;

	for (;;) {
		try {
			await fs.promises.writeFile( lockPath, contents, { flag: 'wx' } );
			break;
		} catch ( error ) {
			if ( error.code === 'ENOENT' ) {
				await fs.promises.mkdir( directory, { recursive: true } );
				continue;
			}
			if ( error.code !== 'EEXIST' ) {
				throw error;
			}
			const holder = await readLockHolder( lockPath );
			if ( ! holder ) {
				continue;
			}
			if ( isStale( holder ) ) {
				await takeOverStaleLock( lockPath, holder );
				continue;
			}
			const now = Date.now();
			if ( now > deadline ) {
				throw new Error(
					`Another wp-env-container process (pid ${ holder.pid ?? 'unknown' }) is working on this project.`
				);
			}
			await new Promise( ( resolve ) => setTimeout( resolve, POLL_MS ) );
		}
	}

	try {
		return await task();
	} finally {
		await releaseLock( lockPath, contents );
	}
}

/**
 * Removes the lock file when it still holds `contents`. A missing file or
 * directory counts as released.
 *
 * @param {string} lockPath Path of the lock file.
 * @param {string} contents What this holder wrote into it.
 * @return {Promise<void>} Resolves once the lock is released.
 */
async function releaseLock( lockPath, contents ) {
	const current = await fs.promises
		.readFile( lockPath, 'utf8' )
		.catch( () => null );
	if ( current === contents ) {
		await fs.promises.rm( lockPath, { force: true } );
	}
}

module.exports = { withLock };
