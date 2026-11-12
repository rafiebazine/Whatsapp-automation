function runWithTimeout(task, timeoutMs, onTimeout) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        if (onTimeout) onTimeout();
        resolve({ timedOut: true });
      } catch (error) {
        resolve({ timedOut: true, error });
      }
    }, timeoutMs);

    Promise.resolve()
      .then(task)
      .then(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ timedOut: false });
      })
      .catch((error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ timedOut: false, error });
      });
  });
}

module.exports = { runWithTimeout };
