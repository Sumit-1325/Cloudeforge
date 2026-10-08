const { execFile } = require("child_process");
const { promisify } = require("util");

// execFile runs a command without an intermediate shell, so arguments are
// never interpreted by a shell — this avoids shell-injection risks entirely.
//
// NOTE: buildImage uses promisified execFile, but pushImage deliberately does
// NOT — docker push streams progress output continuously and can run for
// minutes; the default maxBuffer (1MB) would kill the process with
// "maxBuffer length exceeded" once output grows past it, and there is no way
// to attach a timeout through the promisified form. The manual Promise in
// pushImage sets an explicit timeout, raises maxBuffer, and lets the process
// exit event settle the promise.
const PUSH_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const MAX_BUFFER = 50 * 1024 * 1024; // 50MB of output before giving up
const execFileAsync = promisify(execFile);

// Pushing to a registry is optional: containers run on this same host, so the
// locally built image is enough. When DOCKER_REGISTRY_USERNAME is set, images
// are also pushed to Docker Hub as a backup/for sharing.
//
// Docker Hub requires a <username>/<image>:<tag> reference for pushes to a
// personal account; without the prefix it targets the official library
// namespace, which regular accounts cannot write to ("insufficient_scope").
function isRegistryConfigured() {
  return Boolean(process.env.DOCKER_REGISTRY_USERNAME);
}

// Full image reference: "<username>/<image>:<tag>" when pushing to Docker Hub,
// otherwise a local-only "cloudforge/<image>:<tag>".
function buildImageRef(imageName, tag) {
  const owner = isRegistryConfigured() ? process.env.DOCKER_REGISTRY_USERNAME : "cloudforge";
  return `${owner}/${imageName}:${tag}`;
}

/**
 * Builds a Docker image from a cloned workspace directory.
 *
 * Tags the image via buildImageRef and builds with the workspace as the build
 * context. Assumes a Dockerfile is present in the workspace root.
 *
 * @param {string} workspacePath Absolute path to the cloned repo folder
 * @param {string} imageName     Repository/image name, e.g. "coupon-service"
 * @param {string} tag           Image tag, e.g. "v1"
 * @returns {Promise<string>} The built image reference, e.g. "23106031/coupon-service:v1"
 */
async function buildImage(workspacePath, imageName, tag) {
  const imageRef = buildImageRef(imageName, tag);

  try {
    await execFileAsync("docker", ["build", "-t", imageRef, workspacePath], {
      maxBuffer: MAX_BUFFER,
    });
    return imageRef;
  } catch (err) {
    console.error("[build.buildImage] ", err.message);
    throw new Error(`Failed to build image ${imageRef}: ${err.message}`);
  }
}

// docker push to Docker Hub can fail transiently on flaky connections
// ("timeout awaiting response headers" on a blob upload). Layers that did
// upload are kept by the registry, so each retry only re-sends what's left
// and usually succeeds within a few attempts.
const PUSH_ATTEMPTS = 4;
const PUSH_RETRY_DELAY_MS = 5000;

// Auth/permission failures will never succeed on retry; fail immediately.
const NON_RETRYABLE_PUSH_ERRORS = /denied|insufficient_scope|unauthorized|authentication required/i;

/**
 * Pushes a Docker image to the configured registry, retrying transient
 * network failures up to PUSH_ATTEMPTS times.
 *
 * @param {string} imageRef Image reference to push, e.g. "23106031/coupon-service:v1"
 * @returns {Promise<string>} The pushed image reference
 */
async function pushImage(imageRef) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await pushImageOnce(imageRef);
    } catch (err) {
      if (attempt >= PUSH_ATTEMPTS || NON_RETRYABLE_PUSH_ERRORS.test(err.message)) {
        throw err;
      }
      console.warn(
        `[build.pushImage] attempt ${attempt}/${PUSH_ATTEMPTS} failed, retrying in ${PUSH_RETRY_DELAY_MS / 1000}s`
      );
      await new Promise((r) => setTimeout(r, PUSH_RETRY_DELAY_MS));
    }
  }
}

/**
 * Runs a single docker push.
 *
 * Resolves when the docker push process exits 0, rejects with a clear message
 * if the push exceeds PUSH_TIMEOUT_MS or the process fails.
 *
 * @param {string} imageRef Image reference to push
 * @returns {Promise<string>} The pushed image reference
 */
function pushImageOnce(imageRef) {
  console.log("[build.pushImage] started: " + imageRef);

  return new Promise((resolve, reject) => {
    const child = execFile(
      "docker",
      ["push", imageRef],
      { maxBuffer: MAX_BUFFER, timeout: PUSH_TIMEOUT_MS },
      (err, stdout, stderr) => {
        if (err) {
          // err.killed && err.signal === "SIGTERM" indicates the timeout fired.
          if (err.killed || err.code === null) {
            console.error("[build.pushImage] " + imageRef + " timed out after " + PUSH_TIMEOUT_MS + "ms");
            return reject(new Error(`docker push timed out after ${PUSH_TIMEOUT_MS / 1000}s: ${imageRef}`));
          }
          console.error("[build.pushImage] " + imageRef + " failed: " + err.message);
          return reject(new Error(`Failed to push image ${imageRef}: ${err.message}`));
        }
        console.log("[build.pushImage] completed: " + imageRef);
        resolve(imageRef);
      }
    );

    // Stream progress output to the terminal so a long push is visibly
    // progressing instead of looking stuck.
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);
  });
}

module.exports = { buildImage, pushImage, buildImageRef, isRegistryConfigured };
