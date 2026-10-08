const { execFile } = require("child_process");
const { promisify } = require("util");
const net = require("net");

// Runs deployed apps as plain Docker containers on this host (no Kubernetes).
//
// Each deployment of a project+environment owns a group of containers named
// "<group>-1", "<group>-2", ... where <group> = "cf-<project>-<environment>".
// Every container carries the label cloudforge.app=<group> so the group can be
// listed, scaled, restarted and removed without tracking container IDs.
//
// Replica N (0-based) publishes host port <port + N> -> container port <port>,
// since two containers cannot share one host port.
//
// execFile runs docker without a shell, so arguments are never interpreted by
// a shell — no shell-injection risk from repo or project names.
const execFileAsync = promisify(execFile);
const MAX_BUFFER = 10 * 1024 * 1024;
const GROUP_LABEL = "cloudforge.app";
const STARTUP_CHECK_MS = 3000;

async function docker(args) {
  const { stdout } = await execFileAsync("docker", args, { maxBuffer: MAX_BUFFER });
  return stdout.trim();
}

/**
 * Name shared by all containers of one project+environment deployment.
 *
 * @param {string} projectName Sanitized project name, e.g. "sample-python"
 * @param {string} environment e.g. "development"
 * @returns {string} e.g. "cf-sample-python-development"
 */
function containerGroup(projectName, environment) {
  return `cf-${projectName}-${environment}`;
}

/**
 * Rejects if the given port is already bound on this host, so a deployment can
 * never "succeed" while another process (pgAdmin, Apache, a dev server, another
 * deployment) owns the port.
 *
 * Binds 0.0.0.0 (the wildcard) because that is where host processes hold the
 * port; on Windows a conflicting bind can surface as EACCES rather than
 * EADDRINUSE, so both are treated as "in use".
 *
 * @param {number} port Host port to check
 */
function assertHostPortFree(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", (err) => {
      if (err.code === "EADDRINUSE" || err.code === "EACCES") {
        reject(
          new Error(
            `Port ${port} is already in use on this machine by another process. Choose a different port for this deployment.`
          )
        );
      } else {
        reject(new Error(`Could not verify port ${port} is free: ${err.message}`));
      }
    });
    server.listen(port, "0.0.0.0", () => {
      server.close(() => resolve());
    });
  });
}

/**
 * Lists the container names of a group, ordered by replica number.
 *
 * @param {string} group Container group name
 * @returns {Promise<string[]>} e.g. ["cf-app-development-1", "cf-app-development-2"]
 */
async function listContainers(group) {
  const out = await docker(["ps", "-a", "--filter", `label=${GROUP_LABEL}=${group}`, "--format", "{{.Names}}"]);
  const names = out ? out.split(/\r?\n/) : [];
  const replicaNumber = (name) => parseInt(name.slice(group.length + 1), 10) || 0;
  return names.sort((a, b) => replicaNumber(a) - replicaNumber(b));
}

/**
 * Starts replicas [fromIndex, toIndex) of a group, then verifies each one is
 * still running after a short delay so apps that crash on boot fail the
 * deployment with their logs instead of reporting "running".
 *
 * @param {object} opts
 * @param {string} opts.group Container group name
 * @param {string} opts.image Image reference to run
 * @param {number} opts.port Container port; replica N is published on port + N
 * @param {number} opts.cpus CPU limit in cores, e.g. 0.25
 * @param {number} opts.memoryMi Memory limit in MiB, e.g. 256
 * @param {number} opts.fromIndex First replica index (0-based, inclusive)
 * @param {number} opts.toIndex Last replica index (exclusive)
 */
async function runReplicas({ group, image, port, cpus, memoryMi, fromIndex, toIndex }) {
  for (let i = fromIndex; i < toIndex; i++) {
    await assertHostPortFree(port + i);
  }

  const started = [];
  for (let i = fromIndex; i < toIndex; i++) {
    const name = `${group}-${i + 1}`;
    await docker([
      "run",
      "-d",
      "--name", name,
      "--label", `${GROUP_LABEL}=${group}`,
      "--restart", "unless-stopped",
      "-p", `${port + i}:${port}`,
      "-e", `PORT=${port}`,
      "--cpus", String(cpus),
      "--memory", `${memoryMi}m`,
      image,
    ]);
    started.push(name);
  }

  await new Promise((r) => setTimeout(r, STARTUP_CHECK_MS));
  for (const name of started) {
    const running = await docker(["inspect", "-f", "{{.State.Running}}", name]);
    if (running !== "true") {
      const logs = await getContainerLogs(name, 20).catch(() => "");
      throw new Error(`Container ${name} exited right after starting.${logs ? `\nLast logs:\n${logs}` : ""}`);
    }
  }
}

/**
 * Force-removes every container in a group. Resolves normally when the group
 * has no containers (e.g. the pipeline failed before anything ran).
 *
 * @param {string} group Container group name
 */
async function removeContainers(group) {
  const names = await listContainers(group);
  if (names.length) {
    await docker(["rm", "-f", ...names]);
  }
}

/**
 * Scales a group to the requested number of replicas by starting the missing
 * ones or removing the highest-numbered ones.
 *
 * @param {object} opts Same shape as runReplicas, plus `replicas`
 */
async function scale({ group, image, port, cpus, memoryMi, replicas }) {
  const names = await listContainers(group);
  if (replicas > names.length) {
    await runReplicas({ group, image, port, cpus, memoryMi, fromIndex: names.length, toIndex: replicas });
  } else if (replicas < names.length) {
    await docker(["rm", "-f", ...names.slice(replicas)]);
  }
}

/**
 * Restarts every container in a group.
 *
 * @param {string} group Container group name
 */
async function restart(group) {
  const names = await listContainers(group);
  if (!names.length) {
    throw new Error(`No containers found for ${group}`);
  }
  await docker(["restart", ...names]);
}

async function getContainerLogs(name, tail) {
  // docker logs replays the app's stdout on stdout and its stderr on stderr;
  // merge both so error output isn't lost.
  const { stdout, stderr } = await execFileAsync("docker", ["logs", "--tail", String(tail), name], {
    maxBuffer: MAX_BUFFER,
  });
  return [stdout, stderr].filter(Boolean).join("\n").trim();
}

/**
 * Reads recent logs from the first replica of a group.
 *
 * @param {string} group Container group name
 * @returns {Promise<string>} Raw container logs
 */
async function getLogs(group) {
  const [first] = await listContainers(group);
  if (!first) {
    throw new Error(`No containers found for ${group}`);
  }
  return getContainerLogs(first, 500);
}

module.exports = {
  containerGroup,
  assertHostPortFree,
  listContainers,
  runReplicas,
  removeContainers,
  scale,
  restart,
  getLogs,
};
