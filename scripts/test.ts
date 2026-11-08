import { availableParallelism } from "node:os";

import { spawnSync } from "bun";

// Default worker count: floor(cores / 2), bounded between 1 and 8
const defaultWorkers = Math.min(8, Math.max(1, Math.floor(availableParallelism() / 2)));

const rawArgs = process.argv.slice(2);
const hasParallel = rawArgs.some((arg) => arg === "--parallel" || arg.startsWith("--parallel="));
const hasConcurrent = rawArgs.includes("--concurrent");

const extraArgs: string[] = [];
if (!hasParallel) {
	extraArgs.push(`--parallel=${defaultWorkers}`);
}
if (!hasConcurrent) {
	extraArgs.push("--concurrent");
}

const proc = spawnSync([process.execPath, "test", ...extraArgs, ...rawArgs], {
	stdio: ["inherit", "inherit", "inherit"],
});

process.exit(proc.exitCode ?? 1);