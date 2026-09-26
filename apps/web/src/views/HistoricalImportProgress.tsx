import { useEffect, useState } from "react";
import { getJson } from "../lib/api.js";
interface Task {
  id: string;
  kind: string;
  status: string;
  startDate: string;
  endDate: string;
  planned: number;
  completed: number;
  failed: number;
  skipped: number;
  rows: number;
  estimatedCostUsd: number;
  current: string;
  updatedAt: string;
  error?: string;
}
export function HistoricalImportProgress() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const result = (await getJson("/api/historical-imports/progress")) as {
          tasks: Task[];
        };
        if (active) {
          setTasks(result.tasks);
          setError("");
          setLoaded(true);
        }
      } catch {
        if (active) setError("Import status could not be loaded. Retrying…");
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  return (
    <section className="tw:grid tw:gap-4 tw:p-4">
      <p className="tw:m-0 tw:text-ink-350">
        US historical downloads · refreshes every 5 seconds
      </p>
      {error && <p role="alert">{error}</p>}
      {!loaded && !error && <p>Loading import progress…</p>}
      {loaded && !tasks.length && (
        <p>
          No tracked imports in this container. Imports started before progress
          tracking, or before a container restart, have unavailable task status.
          Previously downloaded data remains saved.
        </p>
      )}
      {tasks.map((task) => {
        const done = task.completed + task.failed;
        const percent = task.planned
          ? Math.min(100, Math.floor((done / task.planned) * 100))
          : 0;
        return (
          <article
            key={task.id}
            className="tw:grid tw:gap-2 tw:rounded-panel tw:border tw:border-line tw:p-4"
          >
            <h3 className="tw:m-0">
              {task.kind} — {task.status}
            </h3>
            <p className="tw:m-0">
              {task.startDate} through {task.endDate}
            </p>
            {task.status === "Planning" ? (
              <p>Estimating cost and checking existing downloads…</p>
            ) : (
              <>
                <progress
                  aria-label={`${task.kind} progress`}
                  value={done}
                  max={task.planned || 1}
                  className="tw:w-full"
                />
                <p className="tw:m-0">
                  {done.toLocaleString()} / {task.planned.toLocaleString()}{" "}
                  chunks ({percent}%) · {task.failed} failed · {task.skipped}{" "}
                  already saved
                </p>
              </>
            )}
            <p className="tw:m-0">
              {task.rows.toLocaleString()} new rows · estimated download cost $
              {task.estimatedCostUsd.toFixed(2)}
            </p>
            <p className="tw:m-0 tw:text-ink-350">{task.current}</p>
            <small>
              Last update: {new Date(task.updatedAt).toLocaleString()}
            </small>
            {task.status === "Stopped" && (
              <p>
                The import process is no longer running. Rerun the same command
                to resume saved chunks.
              </p>
            )}
            {task.error && <p role="alert">{task.error}</p>}
          </article>
        );
      })}
    </section>
  );
}
