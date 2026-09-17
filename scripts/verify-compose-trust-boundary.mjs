import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

/** W5 acceptance check: "Host cannot connect directly to Postgres or scanner in the default
 * profile." Runs `docker compose config` (which resolves env-var defaults, profile inclusion,
 * and file merges exactly as `docker compose up` would) and asserts on the *resolved* service
 * definitions rather than grepping docker-compose.yml's source text, so this stays correct
 * however the file is refactored. */

function composeConfig(args) {
  const result = spawnSync(
    "docker",
    ["compose", ...args, "config", "--format", "json"],
    {
      encoding: "utf8",
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `docker compose ${args.join(" ")} config failed:\n${result.stderr}`,
    );
  }
  return JSON.parse(result.stdout);
}

function publishedPorts(service) {
  return (service?.ports ?? []).map((port) => ({
    hostIp: port.host_ip ?? null,
    target: port.target,
    published: port.published,
  }));
}

let failures = 0;
function check(label, fn) {
  try {
    fn();
    console.log(`ok - ${label}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL - ${label}`);
    console.error(error.message);
  }
}

const defaultConfig = composeConfig([]);

check("postgres readiness waits for the final TCP listener", () => {
  const command = defaultConfig.services.postgres.healthcheck.test.join(" ");
  assert.match(command, /pg_isready\s+-h\s+127\.0\.0\.1\b/);
});

check("default profile publishes no host port for postgres", () => {
  assert.deepEqual(publishedPorts(defaultConfig.services.postgres), []);
});

check("default profile publishes no host port for scanner", () => {
  assert.deepEqual(publishedPorts(defaultConfig.services.scanner), []);
});

check("default profile publishes no host port for api", () => {
  assert.deepEqual(publishedPorts(defaultConfig.services.api), []);
});

check("default profile publishes no host port for worker", () => {
  assert.deepEqual(publishedPorts(defaultConfig.services.worker), []);
});

check("default profile does not start web-remote", () => {
  assert.equal(defaultConfig.services["web-remote"], undefined);
});

check("default profile binds web only to 127.0.0.1", () => {
  const ports = publishedPorts(defaultConfig.services.web);
  assert.equal(ports.length, 1);
  assert.equal(ports[0].hostIp, "127.0.0.1");
  assert.equal(ports[0].target, 8080);
});

check("api and worker require SCANNER_SERVICE_TOKEN to be set", () => {
  for (const name of ["api", "worker"]) {
    const token =
      defaultConfig.services[name].environment.SCANNER_SERVICE_TOKEN;
    assert.ok(
      token && token.length > 0,
      `${name} SCANNER_SERVICE_TOKEN must be non-empty`,
    );
  }
  assert.equal(
    defaultConfig.services.api.environment.SCANNER_SERVICE_TOKEN,
    defaultConfig.services.scanner.environment.SCANNER_SERVICE_TOKEN,
    "api and scanner must share the same token by default",
  );
});

const remoteConfig = composeConfig(["--profile", "remote"]);

check(
  "remote profile starts web-remote published on the configured interface",
  () => {
    const ports = publishedPorts(remoteConfig.services["web-remote"]);
    assert.equal(ports.length, 1);
    assert.equal(ports[0].target, 8443);
  },
);

check("remote profile still keeps postgres/scanner/api off the host", () => {
  for (const name of ["postgres", "scanner", "api", "worker"]) {
    assert.deepEqual(publishedPorts(remoteConfig.services[name]), []);
  }
});

const debugPortsConfig = composeConfig([
  "-f",
  "docker-compose.yml",
  "-f",
  "docker-compose.debug-ports.yml",
]);

const monitoringConfig = composeConfig([
  "-f",
  "docker-compose.yml",
  "-f",
  "docker-compose.monitoring.yml",
  "--profile",
  "monitoring",
]);

check(
  "debug-ports override (test/dev only) republishes postgres and scanner on loopback",
  () => {
    const postgresPorts = publishedPorts(debugPortsConfig.services.postgres);
    const scannerPorts = publishedPorts(debugPortsConfig.services.scanner);
    assert.equal(postgresPorts.length, 1);
    assert.equal(postgresPorts[0].hostIp, "127.0.0.1");
    assert.equal(scannerPorts.length, 1);
    assert.equal(scannerPorts[0].hostIp, "127.0.0.1");
  },
);

check("monitoring overlay does not publish Prometheus or Alertmanager", () => {
  for (const name of ["prometheus", "alertmanager"]) {
    assert.deepEqual(
      publishedPorts(monitoringConfig.services[name]),
      [],
      `${name} must remain on the private Compose network`,
    );
  }
});

const localMonitoringConfig = composeConfig([
  "-f",
  "docker-compose.yml",
  "-f",
  "docker-compose.monitoring.yml",
  "-f",
  "docker-compose.monitoring.local.yml",
  "--profile",
  "monitoring",
]);
check("local monitoring dashboards bind only to loopback", () => {
  for (const name of ["prometheus", "alertmanager"]) {
    const ports = publishedPorts(localMonitoringConfig.services[name]);
    assert.equal(ports.length, 1);
    assert.equal(ports[0].hostIp, "127.0.0.1");
  }
  const config = localMonitoringConfig.services.alertmanager.volumes.filter(
    (volume) => volume.target === "/etc/alertmanager/alertmanager.yml",
  );
  assert.equal(config.length, 1);
  assert.match(config[0].source, /alertmanager\.local\.yml$/);
});

if (failures > 0) {
  console.error(`\n${failures} compose trust-boundary check(s) failed.`);
  process.exit(1);
}
console.log("\nAll compose trust-boundary checks passed.");
