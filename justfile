set shell := ["bash", "-euo", "pipefail", "-c"]

task_app := "apps/tasks-3.x"
dashboard_app := "apps/dashboard"

# Show the available repository commands.
default:
    @just --list

# Report the active toolchain without changing repository state.
doctor:
    @echo "Node:      $(node --version)"
    @echo "npm:       $(npm --version)"
    @echo "Just:      $(just --version)"
    @if command -v meteor >/dev/null 2>&1; then \
        echo "Meteor:    $(meteor --version | head -n 1)"; \
    else \
        echo "Meteor:    unavailable (required for app tests and local servers)"; \
    fi

# Install every workspace from its committed lockfile.
install: install-root install-task install-dashboard

# Install root benchmark-harness dependencies.
install-root:
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci

# Install the benchmark fixture dependencies.
install-task:
    npm ci --prefix "{{ task_app }}"

# Install the dashboard dependencies.
install-dashboard:
    npm ci --prefix "{{ dashboard_app }}"

# Run the fast, credential-free root verification suite.
check: test bench-list playwright-list syntax-check dashboard-css-check

# Run root checks plus both Meteor application test suites.
check-all: check test-task test-dashboard

# Run all Node unit tests.
test:
    npm test

# Run the benchmark fixture's one-shot Meteor tests.
test-task:
    npm test --prefix "{{ task_app }}"

# Run the dashboard's one-shot Meteor tests.
test-dashboard:
    npm test --prefix "{{ dashboard_app }}"

# Discover Playwright scenarios without starting an application.
playwright-list:
    ./node_modules/.bin/playwright test --list

# Run Playwright against an already-running task application.
playwright remote_url="http://localhost:3000":
    REMOTE_URL={{ quote(remote_url) }} ./node_modules/.bin/playwright test

# Check all maintained shell and legacy Node helper files.
syntax-check:
    for file in scripts/*.sh; do bash -n "$file"; done
    for file in scripts/helpers/*.js; do node --check "$file"; done

# List configured benchmark scenarios, apps, and the resolved Meteor source.
bench-list:
    node bench.js list

# Run a scenario; append extra CLI flags after the scenario.
bench scenario="reactive-light" *args:
    #!/usr/bin/env bash
    set -euo pipefail
    scenario="$1"
    shift
    node bench.js run --scenario "$scenario" "$@"

# Run a scenario against a pinned published Meteor release.
bench-release scenario release *args:
    #!/usr/bin/env bash
    set -euo pipefail
    scenario="$1"
    release="$2"
    shift 2
    node bench.js run --scenario "$scenario" --meteor-version "$release" "$@"

# Run a scenario against a local Meteor checkout.
bench-checkout scenario checkout *args:
    #!/usr/bin/env bash
    set -euo pipefail
    scenario="$1"
    checkout="$2"
    shift 2
    node bench.js run --scenario "$scenario" --meteor-checkout "$checkout" "$@"

# Compare two result files using the configured regression thresholds.
compare baseline target format="markdown":
    node bench.js compare --baseline {{ quote(baseline) }} --target {{ quote(target) }} --format {{ quote(format) }}

# Show recent bundle-size history without running a benchmark.
bundle-delta limit="5" format="markdown" warn_kb="50":
    node bench.js bundle-delta --limit {{ quote(limit) }} --format {{ quote(format) }} --warn-kb {{ quote(warn_kb) }}

# Start the task fixture locally.
task-start port="3000":
    cd "{{ task_app }}" && meteor run --port {{ quote(port) }}

# Start the dashboard with its tracked development settings.
dashboard-start port="4000":
    cd "{{ dashboard_app }}" && meteor run --port {{ quote(port) }} --settings settings.json

# Rebuild the dashboard's tracked Tailwind output.
dashboard-css:
    npm run tw --prefix "{{ dashboard_app }}"

# Prove the tracked dashboard CSS matches its Tailwind source.
dashboard-css-check:
    #!/usr/bin/env bash
    set -euo pipefail
    generated_css="$(mktemp)"
    trap 'rm -f "$generated_css"' EXIT
    (
      cd "{{ dashboard_app }}"
      ./node_modules/.bin/tailwindcss -i _tw/main.tailwind.css -o "$generated_css" --minify
      cmp --silent client/main.css "$generated_css"
    )

# Watch dashboard Tailwind sources during local UI development.
dashboard-css-watch:
    npm run tw:watch --prefix "{{ dashboard_app }}"

# Audit production dependencies in every workspace.
audit-production:
    #!/usr/bin/env bash
    set -uo pipefail
    status=0
    for workspace in "." "{{ task_app }}" "{{ dashboard_app }}"; do
      echo
      echo "Auditing production dependencies in $workspace"
      npm audit --omit=dev --prefix "$workspace" || status=1
    done
    exit "$status"
