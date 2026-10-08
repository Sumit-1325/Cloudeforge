const Deployment = require("../models/Deployment");
const Project = require("../models/Project");
const AuditLog = require("../models/AuditLog");
const fs = require("fs/promises");
const repoService = require("../services/repo.service");
const buildService = require("../services/build.service");
const dockerService = require("../services/docker.service");

const MAX_REPLICAS = 10;
const MAX_CPU_CORES = 2; // e.g. "2" cores as a platform-enforced ceiling
const MAX_MEMORY_MI = 2048; // 2Gi

// Host used in the deployed app URL. "localhost" for local use; set it to the
// server's public IP or domain when CloudForge runs on a VPS.
const PUBLIC_HOST = process.env.PUBLIC_HOST || "localhost";

// Container group + resource limits for a deployment, in the shape the docker
// service expects. Shared by the pipeline and every lifecycle action.
function containerSpec(deployment) {
  const projectName = repoService.projectNameFromRepo(deployment.project.repository);
  return {
    group: dockerService.containerGroup(projectName, deployment.environment || "development"),
    image: deployment.image,
    port: deployment.port,
    cpus: parseCpuToCores(deployment.cpu),
    memoryMi: parseMemoryToMi(deployment.memory),
  };
}

function parseCpuToCores(cpu) {
  // supports "500m" (millicores) or "1" (whole cores)
  if (typeof cpu !== "string") return NaN;
  if (cpu.endsWith("m")) return parseInt(cpu, 10) / 1000;
  return parseFloat(cpu);
}

function parseMemoryToMi(memory) {
  // supports "512Mi" or "1Gi"
  if (typeof memory !== "string") return NaN;
  if (memory.endsWith("Gi")) return parseFloat(memory) * 1024;
  if (memory.endsWith("Mi")) return parseFloat(memory);
  return NaN;
}

async function createDeployment(req, res) {
  try {
    const { projectId, branch, environment, replicas, cpu, memory, port } = req.body;

    // --- Validation (platform policy enforced server-side, never trust the frontend) ---
    if (!projectId || !replicas || !cpu || !memory || !port) {
      return res.status(400).json({
        error: "projectId, replicas, cpu, memory and port are required",
      });
    }

    const project = await Project.findOne({ _id: projectId, owner: req.user.id });
    if (!project) {
      return res.status(404).json({ error: "Project not found or not owned by this user" });
    }

    if (replicas < 1 || replicas > MAX_REPLICAS) {
      return res.status(400).json({ error: `replicas must be between 1 and ${MAX_REPLICAS}` });
    }

    const cpuCores = parseCpuToCores(cpu);
    if (isNaN(cpuCores) || cpuCores <= 0 || cpuCores > MAX_CPU_CORES) {
      return res.status(400).json({ error: `cpu must be a valid value up to ${MAX_CPU_CORES} cores` });
    }

    const memoryMi = parseMemoryToMi(memory);
    if (isNaN(memoryMi) || memoryMi <= 0 || memoryMi > MAX_MEMORY_MI) {
      return res.status(400).json({ error: `memory must be a valid value up to ${MAX_MEMORY_MI}Mi` });
    }

    // Replica N is published on host port port + N, so the whole range must fit.
    if (port < 1 || port + replicas - 1 > 65535) {
      return res.status(400).json({ error: "port must be between 1 and 65535 (port + replicas - 1 must also fit)" });
    }

    // --- Persist as "pending" ---
    const deployment = await Deployment.create({
      project: project._id,
      branch: branch || "main",
      environment: environment || "development",
      replicas,
      cpu,
      memory,
      port,
      status: "pending",
      createdBy: req.user.id,
    });

    // Kick off the async deployment pipeline without blocking the response.
    // Status transitions follow the Deployment STATUSES enum; the pipeline
    // catches its own errors and flips the record to "failed" on failure.
    runDeploymentPipeline(deployment, project);

    return res.status(202).json({ deploymentId: deployment._id, status: deployment.status });
  } catch (err) {
    console.error("[deployment.create] ", err);
    return res.status(500).json({ error: "Could not create deployment" });
  }
}

async function getDeployment(req, res) {
  try {
    const deployment = await Deployment.findById(req.params.id).populate("project");
    if (!deployment) {
      return res.status(404).json({ error: "Deployment not found" });
    }
    return res.status(200).json(deployment);
  } catch (err) {
    console.error("[deployment.get] ", err);
    return res.status(500).json({ error: "Could not fetch deployment" });
  }
}

async function listDeployments(req, res) {
  try {
    const projects = await Project.find({ owner: req.user.id }).select("_id");
    const projectIds = projects.map((p) => p._id);
    const deployments = await Deployment.find({ project: { $in: projectIds } })
      .populate("project")
      .sort({ createdAt: -1 });
    return res.status(200).json(deployments);
  } catch (err) {
    console.error("[deployment.list] ", err);
    return res.status(500).json({ error: "Could not fetch deployments" });
  }
}

// Loads a deployment owned by req.user and returns it (or sends a 404 and
// returns null). Shared by every lifecycle action below.
async function findOwnedDeployment(req, res) {
  const deployment = await Deployment.findById(req.params.id).populate("project");
  if (!deployment || !deployment.project || deployment.project.owner.toString() !== req.user.id) {
    res.status(404).json({ error: "Deployment not found" });
    return null;
  }
  return deployment;
}

async function getLogs(req, res) {
  try {
    const deployment = await findOwnedDeployment(req, res);
    if (!deployment) return;

    // No containers yet while the pipeline is still cloning/building/deploying.
    if (deployment.status !== "running") {
      return res.status(409).json({ error: "Deployment is not running yet" });
    }

    const logs = await dockerService.getLogs(containerSpec(deployment).group);

    return res.status(200).json({ logs });
  } catch (err) {
    console.error("[deployment.logs] ", err);
    return res.status(500).json({ error: "Could not fetch deployment logs" });
  }
}

async function scaleDeployment(req, res) {
  try {
    const deployment = await findOwnedDeployment(req, res);
    if (!deployment) return;

    const { replicas } = req.body;
    if (!replicas || replicas < 1 || replicas > MAX_REPLICAS) {
      return res.status(400).json({ error: `replicas must be between 1 and ${MAX_REPLICAS}` });
    }

    if (deployment.port + replicas - 1 > 65535) {
      return res.status(400).json({ error: "Not enough host ports above this deployment's port for that many replicas" });
    }

    const fromReplicas = deployment.replicas;

    try {
      await dockerService.scale({ ...containerSpec(deployment), replicas });
    } catch (err) {
      // Port conflicts / crashing replicas are user-actionable; surface them.
      return res.status(409).json({ error: err.message });
    }

    deployment.replicas = replicas;
    await deployment.save();

    await AuditLog.create({
      user: req.user.id,
      action: "scale",
      deployment: deployment._id,
      metadata: { fromReplicas, toReplicas: replicas },
    });

    return res.status(200).json({ status: "ok", replicas });
  } catch (err) {
    console.error("[deployment.scale] ", err);
    return res.status(500).json({ error: "Could not scale deployment" });
  }
}

async function restartDeployment(req, res) {
  try {
    const deployment = await findOwnedDeployment(req, res);
    if (!deployment) return;

    await dockerService.restart(containerSpec(deployment).group);

    await AuditLog.create({
      user: req.user.id,
      action: "restart",
      deployment: deployment._id,
      metadata: {},
    });

    return res.status(200).json({ status: "ok" });
  } catch (err) {
    console.error("[deployment.restart] ", err);
    return res.status(500).json({ error: "Could not restart deployment" });
  }
}

async function deleteDeployment(req, res) {
  try {
    const deployment = await findOwnedDeployment(req, res);
    if (!deployment) return;

    // Only tear down containers this deployment still owns: a newer deploy of
    // the same project+environment replaces the group and marks this one
    // "stopped", and deleting the old record must not kill the new containers.
    if (deployment.status === "running") {
      await dockerService.removeContainers(containerSpec(deployment).group);
    }

    deployment.status = "deleted";
    await deployment.save();

    await AuditLog.create({
      user: req.user.id,
      action: "delete",
      deployment: deployment._id,
      metadata: {},
    });

    return res.status(200).json({ status: "deleted" });
  } catch (err) {
    console.error("[deployment.delete] ", err);
    return res.status(500).json({ error: "Could not delete deployment" });
  }
}

async function runDeploymentPipeline(deployment, project) {
  const setStatus = async (status, extra = {}) => {
    deployment.status = status;
    deployment.set(extra);
    await deployment.save();
  };

  let workspacePath = null;
  let containersStarted = false;

  // Resource name shared by the image and the containers. Sanitized so a repo
  // like "Hello-World" yields a valid lowercase Docker image name.
  const projectName = repoService.projectNameFromRepo(project.repository);
  const environment = deployment.environment || "development";
  const group = dockerService.containerGroup(projectName, environment);

  try {
    // 1. Clone the repo into a per-deployment workspace folder.
    await setStatus("cloning");
    workspacePath = await repoService.cloneRepo(project.repository, deployment.branch);

    // 2. Detect the project type so the build step can pick the right image tag.
    const projectType = await repoService.detectProjectType(workspacePath);

    // 3. If the repo has no Dockerfile, generate one from the template that
    //    matches the detected project type (node/python). Unknown types with
    //    no template fail fast with a clear message.
    await repoService.ensureDockerfile(workspacePath, projectType);

    // 4. Build the container image.
    await setStatus("building");
    const imageRef = await buildService.buildImage(workspacePath, projectName, `v${Date.now()}`);
    deployment.image = imageRef;
    await deployment.save();

    // 5. Optionally push it to Docker Hub. Containers run on this host from
    //    the local image, so the push is only a backup and is skipped when no
    //    registry is configured.
    if (buildService.isRegistryConfigured()) {
      await setStatus("pushing");
      await buildService.pushImage(imageRef);
    }

    // 6. Replace any previous containers of this project+environment, then
    //    start one container per replica (replica N on host port port + N).
    await setStatus("deploying");
    await dockerService.removeContainers(group);
    await Deployment.updateMany(
      { project: project._id, environment, status: "running", _id: { $ne: deployment._id } },
      { status: "stopped" }
    );

    containersStarted = true;
    await dockerService.runReplicas({
      group,
      image: imageRef,
      port: deployment.port,
      cpus: parseCpuToCores(deployment.cpu),
      memoryMi: parseMemoryToMi(deployment.memory),
      fromIndex: 0,
      toIndex: deployment.replicas,
    });

    // 7. Mark as running and expose the URL of the first replica.
    deployment.url = `http://${PUBLIC_HOST}:${deployment.port}`;
    await setStatus("running");
  } catch (err) {
    console.error("[deployment.pipeline] ", err);
    // Don't leave crashed or half-started replicas behind (they would hold
    // their host ports and keep restarting).
    if (containersStarted) {
      await dockerService.removeContainers(group).catch((cleanupErr) => {
        console.error("[deployment.pipeline] container cleanup failed: ", cleanupErr.message);
      });
    }
    await setStatus("failed", { errorMessage: err.message });
  } finally {
    // Free disk: remove the cloned workspace whether the pipeline succeeded or failed.
    if (workspacePath) {
      try {
        await fs.rm(workspacePath, { recursive: true, force: true });
      } catch (cleanupErr) {
        console.error("[deployment.pipeline] cleanup failed: ", cleanupErr.message);
      }
    }
  }
}

module.exports = {
  createDeployment,
  getDeployment,
  listDeployments,
  getLogs,
  scaleDeployment,
  restartDeployment,
  deleteDeployment,
};
