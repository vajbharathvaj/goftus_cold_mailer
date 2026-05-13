const { execSync } = require("child_process");

const rawPort = process.argv[2] || "3000";
const parsedPort = Number.parseInt(rawPort, 10);
const port = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 3000;

function killProcess(pid) {
  if (!Number.isFinite(pid) || pid <= 0 || pid === process.pid) {
    return false;
  }
  try {
    if (process.platform === "win32") {
      execSync(`taskkill /PID ${pid} /F`, { stdio: "ignore" });
    } else {
      process.kill(pid, "SIGKILL");
    }
    return true;
  } catch (_error) {
    return false;
  }
}

function collectWindowsPids(targetPort) {
  const command = `netstat -ano -p tcp | findstr :${targetPort}`;
  const output = execSync(command, { encoding: "utf8" });
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => /\bLISTENING\b/i.test(line));

  const pids = new Set();
  for (const line of lines) {
    const parts = line.split(/\s+/);
    const pid = Number.parseInt(parts[parts.length - 1], 10);
    if (Number.isFinite(pid) && pid > 0) {
      pids.add(pid);
    }
  }
  return Array.from(pids);
}

function collectUnixPids(targetPort) {
  const commands = [`lsof -ti tcp:${targetPort}`, `lsof -ti:${targetPort}`];
  for (const command of commands) {
    try {
      const output = execSync(command, { encoding: "utf8" });
      const pids = output
        .split(/\r?\n/)
        .map((line) => Number.parseInt(line.trim(), 10))
        .filter((pid) => Number.isFinite(pid) && pid > 0);
      if (pids.length > 0) {
        return Array.from(new Set(pids));
      }
    } catch (_error) {
      // Try next command.
    }
  }
  return [];
}

function main() {
  try {
    const pids = process.platform === "win32" ? collectWindowsPids(port) : collectUnixPids(port);
    if (pids.length === 0) {
      console.log(`[prestart] Port ${port} is already free`);
      return;
    }

    const killed = [];
    for (const pid of pids) {
      if (killProcess(pid)) {
        killed.push(pid);
      }
    }

    if (killed.length > 0) {
      console.log(`[prestart] Cleared port ${port} by stopping PID(s): ${killed.join(", ")}`);
      return;
    }

    console.log(`[prestart] Port ${port} has listener(s), but none could be stopped`);
  } catch (_error) {
    console.log(`[prestart] Port ${port} is already free`);
  }
}

main();
