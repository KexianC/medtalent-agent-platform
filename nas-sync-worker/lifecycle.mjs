export function installShutdownHandlers(runtime, controller, processLike = process) {
  const stop = () => {
    runtime.stopping = true;
    controller.abort();
  };
  processLike.once("SIGINT", stop);
  processLike.once("SIGTERM", stop);
  return () => {
    processLike.removeListener("SIGINT", stop);
    processLike.removeListener("SIGTERM", stop);
  };
}
