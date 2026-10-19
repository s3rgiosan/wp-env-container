# wp-env-container

Runs [wp-env](https://developer.wordpress.org/block-editor/reference-guides/packages/packages-env/) environments on Apple's [`container`](https://github.com/apple/container) runtime. It reads the same `.wp-env.json` through wp-env's own config loader. It starts a development site on `:8888` and a tests site on `:8889`. An MCP server lets agents run PHPUnit, wp-cli and resets against the tests site.

## Requirements

- macOS 26 or later on Apple silicon
- Apple `container` 1.5 or later (`brew install container`, then `container system start`)
- Node.js 22 or later
- `git`, `rsync` and `unzip` (preinstalled on macOS)

## Install

```sh
npm install --save-dev github:s3rgiosan/wp-env-container
```

Add scripts next to your existing wp-env ones:

```json
{
	"scripts": {
		"env:start": "wp-env-container start",
		"env:stop": "wp-env-container stop",
		"test:php": "wp-env-container run tests-cli --env-cwd=wp-content/plugins/my-plugin vendor/bin/phpunit"
	}
}
```

`wpec` is a short alias for `wp-env-container`.

## Commands

| Command | Does |
|---|---|
| `start [--update] [--xdebug[=<modes>]] [--[no-]auto-port]` | Starts the databases, the WordPress sites and, where enabled, phpMyAdmin. |
| `stop` | Stops every container of the project. Data stays. |
| `reset [all\|development\|tests]` | Empties the database of each chosen environment (default `development`) and reinstalls WordPress. |
| `cleanup [-f\|--force]` | Stops everything and deletes the project's databases, downloaded sources and state. Images stay. |
| `destroy [-f\|--force]` | Removes the project's images, then runs `cleanup`. |
| `clean [all\|development\|tests]` | Deprecated alias of `reset`. |
| `run [--config <file>] [--debug] <container> [--env-cwd=<dir>] [--xdebug[=<modes>]] [command..]` | Runs a command in `cli`, `tests-cli`, `wordpress`, `tests-wordpress`, `mysql`, `tests-mysql` or `phpmyadmin`. |
| `logs [all\|development\|tests] [--no-watch]` | Streams the WordPress container output. |
| `status [--json]` | Shows container state, URLs, versions, Xdebug modes, database ports and phpMyAdmin URLs. |
| `mcp [--project <dir>]` | Starts the MCP server on stdio. |

Details for each command:

- `start` downloads sources and configures WordPress on the first run, when `.wp-env.json` changes, or with `--update`. Turning `phpmyadmin` on or off and changing `phpmyadminPort`, `port`, `testsPort` or `mysqlPort` leave the sources, the databases and the unaffected sites alone: `start` changes only the affected containers or site. `--auto-port` and `--no-auto-port` override `"autoPort"` (see [Ports](#ports)). `--xdebug` is described in [Xdebug in the WordPress sites](#xdebug-in-the-wordpress-sites).
- With `"testsEnvironment": false`, `start` stops and deletes the `tests-wordpress`, `tests-mysql` and `tests-phpmyadmin` containers. Their files and database stay.
- With `"phpmyadmin": false`, `start` stops and deletes the `phpmyadmin` and `tests-phpmyadmin` containers (see [phpMyAdmin](#phpmyadmin)).
- `stop` stops a command still running in `cli` or `tests-cli` first, with one `Stopping <container>, a command still running in <cli|tests-cli>.` line per container.
- `reset tests` leaves the development database alone. `reset` fails while a command runs in the `cli` or `tests-cli` container of a chosen environment (see [Running commands](#running-commands)).
- `cleanup` and `destroy` ask for confirmation. Without `--force`, a non-interactive shell cancels with exit code 1. Like `stop`, they stop running `cli` and `tests-cli` commands first and log each one.
- `destroy` removes the WordPress, MariaDB, phpMyAdmin and CLI images, including older `wp-env-container/cli:*` and `wp-env-container/wordpress:*` tags for the project's PHP versions (a disabled tests environment's version included). Images that other containers use stay. Images of other projects' stopped environments count as unused, so their next `start` downloads and rebuilds them. Removal goes by tag, so a tag that shares data with another tag leaves that tag in place.
- `run` with no command opens a shell: `bash` in `cli` and `tests-cli`, `sh` elsewhere. `--xdebug` works in `cli` and `tests-cli` (see [Coverage and Xdebug](#coverage-and-xdebug)).
- `status --json` is described in [Status JSON](#status-json). The Xdebug modes show `off` when Xdebug is not loaded.

### Global options

Every command accepts `--config <file>` for an alternate `.wp-env.json` and `--debug`, which prints each `container` and git command and error stack traces. Unknown options are rejected.

### Passing arguments to `run`

`run` reads `--config`, `--debug`, `--env-cwd` and `--xdebug` only before the command. Everything after the command reaches the container unchanged, including `--help`, `-h` and `--version`. A `--` right after `run` or right before the command ends the options and is dropped.

`run mysql` and `run tests-mysql` start in `/`. `run phpmyadmin` runs in the development phpMyAdmin container. While that container is stopped it fails with `phpMyAdmin is not running. Start the environment with `wp-env-container start`.`, and with `"phpmyadmin"` off the message asks to set `"phpmyadmin": true` first.

### Lifecycle scripts

The `afterStart`, `afterReset`, `afterCleanup` and `afterDestroy` scripts run through a shell in the project directory after the matching command. `afterClean` runs after the deprecated `clean`. A non-zero exit fails the command. `--no-scripts` skips them. Inside a script, call `wp-env-container run …` for container commands.

### `WP_ENV_*` variables

These wp-env variables apply: `WP_ENV_PORT`, `WP_ENV_TESTS_PORT`, `WP_ENV_MYSQL_PORT`, `WP_ENV_TESTS_MYSQL_PORT`, `WP_ENV_PHPMYADMIN_PORT`, `WP_ENV_TESTS_PHPMYADMIN_PORT`, `WP_ENV_PHP_VERSION`, `WP_ENV_CORE` and the other `WP_ENV_*` overrides of wp-env's config loader.

## Configuration

`.wp-env.json` supports these keys: `core`, `plugins`, `themes`, `mappings`, `port`, `testsPort`, `mysqlPort`, `phpmyadmin`, `phpmyadminPort`, `autoPort`, `phpVersion`, `mariadbVersion`, `multisite`, `config`, `env.development`, `env.tests`, `testsEnvironment` and `lifecycleScripts`.

`.wp-env.override.json` next to `.wp-env.json` overrides it. With `--config <file>`, the override file is `<name>.override<ext>` in the same folder, for example `ci.override.json` for `ci.json`.

## Ports

**Sites.** The sites publish on `port` and `testsPort` (8888 and 8889 by default). A busy site port stops `start` with an error.

**Databases.** A root `mysqlPort` applies to the development database only. `env.development.mysqlPort` and `env.tests.mysqlPort` set each database's port. A database without a port gets a random free one and keeps it across restarts while it stays free. With a root `mysqlPort`, the tests database gets a random port and `start` logs:

```
Tests database uses port N; "mysqlPort" P belongs to the development database.
```

Different `mysqlPort` values for development and tests are both strict. A busy `mysqlPort` is always an error.

**phpMyAdmin.** A configured `phpmyadminPort` is strict, and a busy one is an error. Without one, phpMyAdmin gets a random free port and keeps it across restarts while it stays free. A root `phpmyadminPort` applies to both environments: the development phpMyAdmin uses it, the tests phpMyAdmin gets a random port, and `start` logs:

```
Tests phpMyAdmin uses port N; "phpmyadminPort" P belongs to the development phpMyAdmin.
```

`WP_ENV_PHPMYADMIN_PORT` and `WP_ENV_TESTS_PHPMYADMIN_PORT` set the port per environment and turn phpMyAdmin on.

**Automatic ports.** With `"autoPort": true` in `.wp-env.json`, or `start --auto-port`, a busy site port moves to the next free port above it. `--no-auto-port` turns this off for one run. Setting `CI` turns it off entirely, and the busy-port error then ends with `(automatic port selection is off while CI is set)`.

**Order.** `start` reserves configured strict ports first: `port` and `testsPort` without `autoPort`, `mysqlPort` and `phpmyadminPort`. Saved, random and automatic ports follow.

**Running environments.** `start` keeps the ports of running containers. With `autoPort`, a running site moves to a changed `port` when that port is free and stays on its current port while the configured port is busy. Every command and the MCP server read the ports from the running containers. `status` shows the ports in use.

**URL updates.** When a site's port differs from the one WordPress was installed with, `start` points `WP_SITEURL`, `WP_HOME`, `WP_TESTS_DOMAIN` and the `siteurl` and `home` options at the new port. For a multisite, a changed port or host also runs `wp search-replace <old host> <new host> --network --all-tables-with-prefix` and updates `DOMAIN_CURRENT_SITE` when it is defined.

**Multisite constants.** On a new or reset database, `start` and `reset` remove `WP_ALLOW_MULTISITE`, `MULTISITE`, `SUBDOMAIN_INSTALL`, `DOMAIN_CURRENT_SITE`, `PATH_CURRENT_SITE`, `SITE_ID_CURRENT_SITE` and `BLOG_ID_CURRENT_SITE` from `wp-config.php` before installing WordPress. A multisite install writes them again for the current host, and a single site installs without them. Constants from `config` in `.wp-env.json` are applied afterwards.

**Network binding.** The sites listen on all interfaces, so other devices on the local network can reach them. Both MariaDB ports and both phpMyAdmin ports publish on `127.0.0.1` only, because phpMyAdmin logs in to the database as `root`. `start` recreates a running database or phpMyAdmin published on another address on `127.0.0.1`.

## phpMyAdmin

`"phpmyadmin": true` in `.wp-env.json` starts a phpMyAdmin container for each enabled environment, logged in to that environment's database as `root`. `phpmyadminPort` implies it. `start` prints the URLs:

```
phpMyAdmin started at http://localhost:<port>
phpMyAdmin for automated testing started at http://localhost:<port>
```

`start` recreates a phpMyAdmin container when its image, database address or published port changes, when a pull moved the local `phpmyadmin` tag to a new digest, and on `start --update`. When only phpMyAdmin is out of date (stopped, crashed or on a moved port), `start` restarts just phpMyAdmin. `Environment already running.` appears only when every wanted phpMyAdmin already runs against the current database on its port. Turning off `phpmyadmin` or `testsEnvironment` removes the containers on the next `start`. The `phpmyadmin` image is pulled with the others, and `start --update` pulls it again.

## Running commands

`run cli`, `run tests-cli`, `tests_wp_cli` and `tests_phpunit` start a one-shot container. They hold the project lock while they read the database address and start that container, and release it once the container runs. A long command or an interactive shell never holds up `start`.

While such a command runs, `start` fails when it would recreate that environment's database or configure its WordPress again. `reset` (and the MCP `tests_reset`) fails for that environment. The error reads:

```
A command is still running in tests-cli (<container>). Wait for it to finish or stop it with `container stop <container>`.
```

With several commands it reads `Commands are still running in …`. A command container that has exited counts as finished, and one created less than 10 minutes ago that has not started yet counts as running. A `start` with nothing to change reports `Environment already running.`, and a `start` that recreates only the web containers, such as one with a changed `--xdebug`, goes ahead.

`run wordpress`, `run tests-wordpress`, `run mysql`, `run tests-mysql` and `run phpmyadmin` use `container exec`. They end when `start` recreates their container.

## Coverage and Xdebug

The CLI image loads PCOV, so coverage needs no flag:

```sh
wpec run tests-cli --env-cwd=wp-content/plugins/my-plugin vendor/bin/phpunit --coverage-text
```

Through the MCP server, pass `extraArgs: ["--coverage-text"]` to `tests_phpunit`. The project's `phpunit.xml` needs a coverage filter (`<coverage><include>…</include></coverage>` in PHPUnit 9, `<source>` in PHPUnit 10 and later).

`--xdebug` loads Xdebug in `cli` or `tests-cli` for one command and turns PCOV off for it. It defaults to step debugging. `--xdebug=<modes>` takes a comma-separated list of `off`, `develop`, `coverage`, `debug`, `gcstats`, `profile` and `trace`. `--xdebug=off` still loads Xdebug, with `XDEBUG_MODE=off`.

```sh
wpec run tests-cli --xdebug --env-cwd=wp-content/plugins/my-plugin vendor/bin/phpunit
```

`tests_phpunit` takes the same modes in its `xdebug` input, for example `{ "xdebug": "debug" }`.

Xdebug starts with every PHP process. It connects to the macOS host at the gateway of the `container` default network (usually `192.168.64.1`) on port 9003, so the IDE must listen on port 9003 on all interfaces. A WordPress PHPUnit run opens two sessions: PHPUnit itself, and the separate `install.php` process that the WordPress test bootstrap starts.

In PhpStorm, add a server named `wp-env-container` and map `/var/www/html/wp-content/plugins/<plugin>` to the plugin folder. Xdebug needs PHP 7.2 or later. PCOV needs PHP 7.1 or later.

### Xdebug in the WordPress sites

`start --xdebug` loads Xdebug in the `wordpress` and `tests-wordpress` containers, with the same modes as `run --xdebug` (default `debug`):

```sh
wpec start --xdebug
wpec start --xdebug=debug,profile
```

Each `start` sets the state: `start` without `--xdebug`, or with `--xdebug=off`, turns Xdebug off. When the modes change, `start` recreates the two WordPress containers and keeps the database and the WordPress install. `status` shows the modes of each site. Mode lists are sorted and deduplicated, so `--xdebug=develop,debug` shows as `debug,develop`.

With Xdebug on, the sites run a locally built `wp-env-container/wordpress:php<version>-<hash>` image: the stock `wordpress:php<version>` image plus Xdebug. The first `start --xdebug` per PHP version builds it, the same way as the CLI image.

Every request starts a debugging session, with no trigger needed. The image sets `xdebug.log_level=0`, so requests without a listening IDE log no connection errors. Xdebug connects to the host gateway on port 9003, so the IDE must listen on port 9003 on all interfaces.

On a PHP version below 7.2, `start` fails with `Xdebug needs PHP 7.2 or later; the <env> environment uses PHP <version>.`

In PhpStorm, use the server named `wp-env-container`. Map `/var/www/html` to the core folder in `~/.wp-env-container/<project>/WordPress` (`tests-WordPress` for the tests site), and `/var/www/html/wp-content/plugins/<plugin>` to the plugin folder.

## MCP server

Add it to the project's `.mcp.json`:

```json
{
	"mcpServers": {
		"wp-env-container": {
			"command": "npx",
			"args": [ "wp-env-container", "mcp" ]
		}
	}
}
```

The server works on the tests environment. It reloads `.wp-env.json` on every call and never starts or stops containers. Every tool returns an error result when the environment is down (with a pointer to `wp-env-container start`) or when a run fails. The exception is `tests_logs` with `source: "debug_log"`, which reads the file from the host and works while the environment is stopped.

| Tool | Input | Result |
|---|---|---|
| `tests_status` | none | `projectId`. `tests`: `running`, `container`, `url`, `port`, `wordpressVersion`, `phpVersion`, `image`, `xdebug`. `database`: `running`, `container`, `host`, `port`, `image`. `phpmyadmin`: `running`, `container`, `url`, `port`, or `null` when `"phpmyadmin"` is off. Error when the tests environment is not running or `testsEnvironment` is `false`. |
| `tests_logs` | `source`: `apache` \| `debug_log` (default `apache`), `lines`: 1-2000 (default 100) | Recent Apache/PHP output, or the tail of `wp-content/debug.log`. |
| `tests_wp_cli` | `args: string[]`, `cwd?`, `timeoutSeconds`: 1-3600 (default 300) | `exitCode`, `stdout`, `stderr`, `timedOut`. Arguments are passed without a shell. Error on a non-zero exit or a timeout. |
| `tests_phpunit` | `path?`, `filter?`, `testsuite?`, `configuration?`, `extraArgs` (default `[]`), `timeoutSeconds`: 10-3600 (default 600), `xdebug?` (Xdebug modes, e.g. `debug` or `coverage`) | `passed`, a `summary` (test, assertion, failure, error, skipped and warning counts; `null` without a JUnit report), each failed test with its message, and the tail of the output. Error unless `passed` is true. |
| `tests_reset` | none | Empties the tests database and reinstalls WordPress with the configured plugins. Error when `testsEnvironment` is `false`. |

`tests_phpunit` runs in the first plugin from `.wp-env.json` unless `path` is given. It uses the project's `vendor/bin/phpunit` when present and the PHPUnit bundled in the CLI image otherwise. Results come from a JUnit report, so counts and failure messages are exact.

## Status JSON

`status --json` prints one object:

- `projectId`, `stateDirectory`, `environments`: the project id, its state folder and one entry per enabled environment (`development`, `tests`).
- Per environment: `running`, `container`, `url`, `port`, `wordpressVersion`, `phpVersion`, `image` and `xdebug` (`off` when not loaded).
- `database` in each environment: `running`, `container`, `host` (the container IP), `port` (the published host port) and `image`. `host` and `port` are `null` when stopped.
- `phpmyadmin` in each environment: `running`, `container`, `url` and `port` (`url` and `port` are `null` when stopped), or `null` when `"phpmyadmin"` is off for that environment.

## How it works

Each container is a lightweight VM. A project runs the development database and site, the tests database and site, and a phpMyAdmin container per environment where `"phpmyadmin"` is on. With `"testsEnvironment": false`, only the development containers run.

| Container | Image | Purpose |
|---|---|---|
| `<project>-mysql` | `mariadb:<version>` from `mariadbVersion` (default `mariadb:lts`) | Development database `wordpress`, data in `mysql/`. |
| `<project>-wordpress` | `wordpress:php<version>`, or `wp-env-container/wordpress:php<version>-<hash>` with Xdebug | Development site on port 8888. |
| `<project>-phpmyadmin` | `phpmyadmin` | phpMyAdmin for the development database; only with `"phpmyadmin": true`. |
| `<project>-tests-mysql` | `mariadb:<version>` from the tests `mariadbVersion` | Tests database `tests-wordpress`, data in `tests-mysql/`. |
| `<project>-tests-wordpress` | `wordpress:php<version>`, or `wp-env-container/wordpress:php<version>-<hash>` with Xdebug | Tests site on port 8889. |
| `<project>-tests-phpmyadmin` | `phpmyadmin` | phpMyAdmin for the tests database; only with `"phpmyadmin": true` and the tests environment. |

`cli` and `tests-cli` are one-shot containers from a locally built `wp-env-container/cli:php<version>-<hash>` image (wp-cli, Composer, PHPUnit, PCOV and Xdebug). Each command starts one with the same mounts as its site. The image is built once per PHP version and recipe. The hash comes from its Containerfile, so a changed recipe builds a new image and removes the older ones for that PHP version. The BuildKit VM that builds it is stopped afterwards.

- Containers, phpMyAdmin included, reach the database by IP, read fresh on every start, because Apple `container` has no name-based DNS between containers.
- MariaDB runs as `999:999` so its bind-mounted data folder works on virtiofs.
- Mounts: core at `/var/www/html`, then mappings, plugins and themes, plus the WordPress PHPUnit library at `/wordpress-phpunit` (`WP_TESTS_DIR`).
- State lives in `~/.wp-env-container/<project>/`. `WP_ENV_CONTAINER_HOME` changes the root. A leading `~` expands to the home folder, and symlinks and letter case resolve, so different spellings of one folder share the state folder and the containers. A custom home gives the project's containers their own names, so runs with different homes never touch each other's containers.
- Containers carry `dev.wp-env-container.*` labels. `stop`, `status` and `destroy` find them by label.
- A lock file in the state folder keeps the CLI and MCP server from starting, resetting or destroying the same project at once, and from starting a one-shot command meanwhile.

## Differences from wp-env

- SPX and the Playground runtime (`--runtime playground`) are not supported.
- Databases and phpMyAdmin listen on `127.0.0.1` only.
- `WP_ENV_TESTS_PHPMYADMIN_PORT` also turns the tests phpMyAdmin on. A value of `0` is ignored, as with `WP_ENV_PHPMYADMIN_PORT`, and wp-env's loader rejects a non-integer value.
- Container names stay within 63 characters: a long project folder name is shortened in the project id, while its `-<8hex>` hash and the `-<6hex>` custom home suffix stay whole.
- State lives in `~/.wp-env-container/`, apart from wp-env's `~/.wp-env/`, so both tools can manage the same project.
- Inside lifecycle scripts, `wp-env run …` still targets Docker wp-env. Use `wp-env-container run …`.

## Development

```sh
npm run lint                # ESLint with the WordPress rules and wp-prettier
npm test                    # unit tests, no containers needed
npm run test:integration    # full lifecycle against Apple container (5–10 min, needs network)
```

## Environment variables

- `WP_ENV_CONTAINER_HOME`: root of the state folders (default `~/.wp-env-container`). A custom home gives the project's containers their own names.
- `WP_ENV_CONTAINER_BIN`: path to the `container` binary (default `/usr/local/bin/container`).
- `WP_ENV_CONTAINER_DEBUG`: turns on the `--debug` output; `0`, `false`, `no`, `off` and an empty value turn it off.
- `WP_ENV_CONTAINER_E2E=1`: enables the integration test; `npm run test:integration` sets it.

## License

MIT. See [LICENSE](LICENSE).
