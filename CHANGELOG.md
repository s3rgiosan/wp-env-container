# Changelog

All notable changes to wp-env-container will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-10-20

### Added

- The `wp-env-container` CLI (alias `wpec`) runs wp-env environments on Apple `container`, with a development site on port 8888 and a tests site on port 8889, and offers the `start`, `stop`, `reset`, `cleanup`, `destroy`, `run` and `logs` commands, plus `clean` as a deprecated alias of `reset`.
- The CLI reads `.wp-env.json`, `.wp-env.override.json`, a custom file through `--config` and the `WP_ENV_*` variables through wp-env's own config loader.
- The development and tests environments use separate databases, each with its own data folder and optional `mysqlPort`, and `"testsEnvironment": false` removes the tests containers.
- `"phpmyadmin": true` or `phpmyadminPort` starts a phpMyAdmin container for each enabled environment, logged in to its database, with `run phpmyadmin` for a shell.
- `"autoPort": true` and `start --auto-port` move a busy site port to the next free one, while databases and phpMyAdmin keep a random free port across restarts and listen on `127.0.0.1` only.
- `start` updates the WordPress URLs when a site port changes, including the search-replace and `DOMAIN_CURRENT_SITE` update for a multisite network.
- The `afterStart`, `afterReset`, `afterCleanup`, `afterDestroy` and `afterClean` lifecycle scripts run after their commands, and `--no-scripts` skips them.
- A locally built CLI image provides wp-cli, Composer, PHPUnit and PCOV, and `run --xdebug[=<modes>]` loads Xdebug for a single command.
- `start --xdebug[=<modes>]` loads Xdebug in the WordPress sites, where every request starts a debugging session.
- `status` and `status --json` report container state, URLs, versions, Xdebug modes, database ports and phpMyAdmin.
- A command still running through `run cli`, `run tests-cli` or the MCP `tests_wp_cli` and `tests_phpunit` tools blocks a `start` or `reset` that would recreate its environment, and `stop`, `cleanup` and `destroy` stop the command first.
- Projects with a custom `WP_ENV_CONTAINER_HOME` get their own container names, so different homes never touch each other's containers.
- The `--debug` flag and the `WP_ENV_CONTAINER_DEBUG` variable print each `container` and git command and error stack traces.
- The MCP server offers the `tests_status`, `tests_logs`, `tests_wp_cli`, `tests_phpunit` and `tests_reset` tools for the tests environment.
- A fresh or reset database removes stale multisite constants from `wp-config.php` before WordPress installs.
- `start` restarts only phpMyAdmin when it alone is out of date, and a change to `phpmyadmin`, `phpmyadminPort`, `port`, `testsPort` or `mysqlPort` touches only the affected containers or site.
- `WP_ENV_CONTAINER_HOME` expands a leading `~` and resolves symlinks and letter case, and container names stay within 63 characters through a shortened project id.
- A lock file keeps the CLI and the MCP server from starting, resetting or destroying the same project at once.

[Unreleased]: https://github.com/s3rgiosan/wp-env-container/compare/1.0.0...HEAD
[1.0.0]: https://github.com/s3rgiosan/wp-env-container/releases/tag/1.0.0
