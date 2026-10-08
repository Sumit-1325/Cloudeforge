import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import client from "../api/client";
import Layout from "../components/Layout";
import StatusBadge from "../components/StatusBadge";

const TERMINAL_STATUSES = ["running", "failed", "deleted", "stopped"];
const POLL_MS = 3000;

function formatDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

export default function DeploymentDetail() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [deployment, setDeployment] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // scale inline input
  const [scaleOpen, setScaleOpen] = useState(false);
  const [scaleValue, setScaleValue] = useState("1");
  const [actionError, setActionError] = useState("");
  const [actionLoading, setActionLoading] = useState(false);

  // logs
  const [logs, setLogs] = useState("");
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsMessage, setLogsMessage] = useState(""); // muted notice or error

  // transient success toast
  const [toast, setToast] = useState("");
  const toastTimer = useRef(null);

  const status = deployment?.status;

  const fetchDeployment = useCallback(async () => {
    try {
      const { data } = await client.get(`/deployments/${id}`);
      setDeployment(data);
      setError("");
    } catch (err) {
      if (err.response?.status === 404) {
        setError("Deployment not found.");
      } else {
        setError("Could not load deployment.");
      }
    } finally {
      setLoading(false);
    }
  }, [id]);

  // Poll while the deployment is still moving through the pipeline; stop once
  // it reaches a terminal-ish state to avoid wasted requests.
  useEffect(() => {
    fetchDeployment();
    if (status && TERMINAL_STATUSES.includes(status)) return undefined;

    const interval = setInterval(() => {
      fetchDeployment();
    }, POLL_MS);
    return () => clearInterval(interval);
  }, [fetchDeployment, status]);

  // Scale the inline input to the current replica count when the panel opens.
  useEffect(() => {
    if (deployment) setScaleValue(String(deployment.replicas ?? 1));
  }, [deployment?.replicas]); // eslint-disable-line react-hooks/exhaustive-deps

  function showToast(message) {
    setToast(message);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 4000);
  }

  async function fetchLogs() {
    setLogsLoading(true);
    setLogsMessage("");
    try {
      const { data } = await client.get(`/deployments/${id}/logs`);
      setLogs(data.logs || "");
    } catch (err) {
      if (err.response?.status === 409) {
        setLogsMessage("Logs will appear once the deployment is running.");
        setLogs("");
      } else {
        setLogsMessage(err.response?.data?.error || "Could not fetch logs.");
      }
    } finally {
      setLogsLoading(false);
    }
  }

  useEffect(() => {
    // Fetch logs automatically when the deployment is running, and whenever
    // the page first loads for an already-running deployment.
    if (status === "running") fetchLogs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  async function handleScale(e) {
    e.preventDefault();
    setActionError("");
    setActionLoading(true);
    try {
      await client.post(`/deployments/${id}/scale`, { replicas: parseInt(scaleValue, 10) });
      setScaleOpen(false);
      showToast(`Scaled to ${scaleValue} replicas.`);
      await fetchDeployment();
    } catch (err) {
      setActionError(err.response?.data?.error || "Could not scale deployment.");
    } finally {
      setActionLoading(false);
    }
  }

  async function handleRestart() {
    if (!window.confirm("Restart this deployment? All of its containers will be restarted.")) return;
    setActionError("");
    setActionLoading(true);
    try {
      await client.post(`/deployments/${id}/restart`);
      showToast("Restart triggered.");
      await fetchDeployment();
    } catch (err) {
      setActionError(err.response?.data?.error || "Could not restart deployment.");
    } finally {
      setActionLoading(false);
    }
  }

  async function handleDelete() {
    if (!window.confirm("Delete this deployment? This cannot be undone.")) return;
    setActionError("");
    setActionLoading(true);
    try {
      await client.delete(`/deployments/${id}`);
      navigate("/");
    } catch (err) {
      setActionError(err.response?.data?.error || "Could not delete deployment.");
      setActionLoading(false);
    }
  }

  const running = status === "running";
  const projectName = deployment?.project?.name || "unknown";

  return (
    <Layout>
      <div className="mb-6 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <Link to="/" className="text-muted text-sm hover:text-text transition">
            ← Deployments
          </Link>
          <h1 className="text-xl font-semibold tracking-tight mt-1 truncate">
            {projectName}
          </h1>
          <div className="flex items-center gap-3 mt-1.5">
            <StatusBadge status={status} />
            <span className="text-muted text-sm font-mono truncate">{deployment?._id}</span>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => setScaleOpen((v) => !v)}
            disabled={!running}
            className="bg-panel border border-border text-text text-sm px-3 py-1.5 rounded hover:bg-panelhover disabled:opacity-40 disabled:cursor-not-allowed transition"
            title={running ? "Change replica count" : "Only available once running"}
          >
            Scale
          </button>
          <button
            onClick={handleRestart}
            disabled={!running || actionLoading}
            className="bg-panel border border-border text-text text-sm px-3 py-1.5 rounded hover:bg-panelhover disabled:opacity-40 disabled:cursor-not-allowed transition"
            title={running ? "Restart all containers" : "Only available once running"}
          >
            Restart
          </button>
          <button
            onClick={handleDelete}
            disabled={actionLoading}
            className="bg-failed/10 border border-failed/30 text-failed text-sm px-3 py-1.5 rounded hover:bg-failed/20 disabled:opacity-40 disabled:cursor-not-allowed transition"
          >
            Delete
          </button>
        </div>
      </div>

      {toast && (
        <div className="mb-4 border border-running/30 bg-running/10 text-running text-sm rounded px-3 py-2">
          {toast}
        </div>
      )}

      {loading && <p className="text-muted text-sm">Loading...</p>}

      {error && (
        <div>
          <p className="text-failed text-sm border border-failed/30 bg-failed/10 rounded px-3 py-2">
            {error}
          </p>
        </div>
      )}

      {!loading && !error && deployment && (
        <>
          {deployment.status === "failed" && deployment.errorMessage && (
            <div className="mb-6 border border-failed/30 bg-failed/10 rounded px-4 py-3">
              <p className="text-failed text-sm font-medium mb-1">Deployment failed</p>
              <p className="text-failed/90 text-sm font-mono whitespace-pre-wrap break-words">
                {deployment.errorMessage}
              </p>
            </div>
          )}

          {/* Details grid */}
          <div className="border border-border rounded-lg overflow-hidden mb-6">
            <dl className="grid grid-cols-2 md:grid-cols-3 gap-px bg-border">
              {[
                ["Project", projectName],
                ["Repository", deployment.project?.repository],
                ["Branch", deployment.branch],
                ["Environment", deployment.environment],
                ["Replicas", String(deployment.replicas)],
                ["CPU", deployment.cpu],
                ["Memory", deployment.memory],
                ["Port", String(deployment.port)],
                ["Image", deployment.image || "—"],
                ["Created", formatDate(deployment.createdAt)],
                ["Updated", formatDate(deployment.updatedAt)],
              ].map(([label, value]) => (
                <div key={label} className="bg-panel px-4 py-3">
                  <dt className="text-xs text-muted uppercase tracking-wide mb-1">{label}</dt>
                  <dd className="text-sm text-text font-mono break-all">{value}</dd>
                </div>
              ))}
            </dl>

            <div className="bg-panel px-4 py-3 border-t border-border">
              <dt className="text-xs text-muted uppercase tracking-wide mb-1">URL</dt>
              {running && deployment.url ? (
                <a
                  href={deployment.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-running hover:underline text-sm font-mono break-all"
                >
                  {deployment.url}
                </a>
              ) : (
                <dd className="text-sm text-muted font-mono">
                  {status === "deleted"
                    ? "Deployment deleted"
                    : status === "stopped"
                      ? "Replaced by a newer deployment of this project."
                      : "URL will appear once the deployment is running."}
                </dd>
              )}
            </div>
          </div>

          {/* Inline scale input */}
          {scaleOpen && (
            <form
              onSubmit={handleScale}
              className="mb-6 border border-border rounded-lg p-4 bg-panel flex flex-wrap items-end gap-3"
            >
              <div>
                <label htmlFor="cf-scale" className="block text-sm text-muted mb-1.5">
                  Replicas (1–10)
                </label>
                <input
                  id="cf-scale"
                  type="number"
                  min="1"
                  max="10"
                  required
                  value={scaleValue}
                  onChange={(e) => setScaleValue(e.target.value)}
                  className="w-32 bg-base border border-border rounded px-3 py-2 text-sm focus:border-running outline-none"
                />
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="submit"
                  disabled={actionLoading}
                  className="bg-running text-base font-medium rounded px-4 py-2 text-sm hover:opacity-90 disabled:opacity-50 transition"
                >
                  {actionLoading ? "Scaling..." : "Apply"}
                </button>
                <button
                  type="button"
                  onClick={() => setScaleOpen(false)}
                  className="text-muted text-sm hover:text-text transition"
                >
                  Cancel
                </button>
              </div>
            </form>
          )}

          {actionError && (
            <p className="text-failed text-sm border border-failed/30 bg-failed/10 rounded px-3 py-2 mb-6">
              {actionError}
            </p>
          )}

          {/* Logs */}
          <div className="border border-border rounded-lg overflow-hidden mb-6">
            <div className="flex items-center justify-between bg-panel px-4 py-2.5 border-b border-border">
              <h2 className="text-sm font-medium text-text">Logs</h2>
              <button
                onClick={fetchLogs}
                disabled={logsLoading}
                className="text-xs text-muted hover:text-text disabled:opacity-50 transition"
              >
                {logsLoading ? "Fetching..." : "Refresh"}
              </button>
            </div>

            {logsMessage && !logs && (
              <p className="text-muted text-sm px-4 py-6">{logsMessage}</p>
            )}

            {logs ? (
              <pre className="bg-base text-text/90 text-xs font-mono p-4 overflow-x-auto max-h-96 overflow-y-auto whitespace-pre-wrap break-words">
                {logs}
              </pre>
            ) : (
              !logsMessage && (
                <p className="text-muted text-sm px-4 py-6">
                  {status === "running"
                    ? logsLoading
                      ? "Fetching logs..."
                      : "No logs yet."
                    : "Logs will appear once the deployment is running."}
                </p>
              )
            )}
          </div>
        </>
      )}
    </Layout>
  );
}
