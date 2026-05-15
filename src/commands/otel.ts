import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir, platform } from "node:os";
import { join as joinPath } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const OTEL_DIR = joinPath(homedir(), ".pi", "agent", "otel");
const PID_FILE = joinPath(OTEL_DIR, "aspire.pid");
const LOG_FILE = joinPath(OTEL_DIR, "aspire.log");
const META_FILE = joinPath(OTEL_DIR, "aspire.meta.json");

const OTLP_GRPC_PORT = 4317;
const OTLP_HTTP_PORT = 4318;
const UI_PORT = 18888;
const UI_URL = `http://localhost:${UI_PORT}`;
const DOCKER_CONTAINER = "pi-otel-aspire";

const SUBCOMMANDS = ["start", "stop", "connect"] as const;
type Sub = (typeof SUBCOMMANDS)[number];

const PROTOCOLS = ["grpc", "http/protobuf", "http/json"] as const;
type Protocol = (typeof PROTOCOLS)[number];
const DEFAULT_CONNECT_ENDPOINT = `http://localhost:${4317}`;
const DEFAULT_CONNECT_PROTOCOL: Protocol = "grpc";

type Driver = "aspire" | "docker" | "podman";
type Meta = { driver: Driver; pid: number; startedAt: string };

function ensureDir(): void {
	mkdirSync(OTEL_DIR, { recursive: true });
}

function isWindows(): boolean {
	return platform() === "win32";
}

function hasExe(cmd: string): boolean {
	const which = isWindows() ? "where" : "which";
	const r = spawnSync(which, [cmd], { stdio: "ignore" });
	return r.status === 0;
}

function detectDriver(): Driver | null {
	if (hasExe("aspire")) return "aspire";
	if (hasExe("docker")) {
		// verify daemon reachable
		const r = spawnSync("docker", ["info"], { stdio: "ignore" });
		if (r.status === 0) return "docker";
	}
	if (hasExe("podman")) {
		const r = spawnSync("podman", ["info"], { stdio: "ignore" });
		if (r.status === 0) return "podman";
	}
	return null;
}

function probePort(p: number, timeoutMs = 300): Promise<boolean> {
	return new Promise((resolve) => {
		const sock = createConnection({ port: p, host: "127.0.0.1" });
		const done = (ok: boolean) => {
			sock.destroy();
			resolve(ok);
		};
		sock.setTimeout(timeoutMs);
		sock.once("connect", () => done(true));
		sock.once("timeout", () => done(false));
		sock.once("error", () => done(false));
	});
}

async function waitForPort(p: number, totalMs = 5000): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < totalMs) {
		if (await probePort(p)) return true;
		await new Promise((r) => setTimeout(r, 200));
	}
	return false;
}

function readMeta(): Meta | null {
	try {
		return JSON.parse(readFileSync(META_FILE, "utf8")) as Meta;
	} catch {
		return null;
	}
}

function writeMeta(m: Meta): void {
	writeFileSync(META_FILE, JSON.stringify(m, null, 2));
	writeFileSync(PID_FILE, String(m.pid));
}

function clearMeta(): void {
	for (const f of [PID_FILE, META_FILE]) {
		try {
			rmSync(f, { force: true });
		} catch {}
	}
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function killPid(pid: number): void {
	if (isWindows()) {
		spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" });
	} else {
		try {
			process.kill(pid, "SIGTERM");
		} catch {}
	}
}

function tailLog(maxBytes = 1500): string {
	try {
		const buf = readFileSync(LOG_FILE, "utf8");
		return buf.length > maxBytes ? buf.slice(-maxBytes) : buf;
	} catch {
		return "(no log)";
	}
}

const ASPIRE_INSTALL_HINT =
	isWindows()
		? "Install Aspire CLI:   irm https://aspire.dev/install.ps1 | iex"
		: "Install Aspire CLI:   curl -sSL https://aspire.dev/install.sh | bash";
const DOCKER_INSTALL_HINT = "Install Docker Desktop (https://docs.docker.com/desktop/) or Podman (https://podman.io/).";

function noDriverMessage(): string {
	return [
		"Neither `aspire` CLI nor a container runtime (docker/podman) was found.",
		"Install one of:",
		`  - ${ASPIRE_INSTALL_HINT}`,
		`  - ${DOCKER_INSTALL_HINT}`,
	].join("\n");
}

function spawnAspire(logFd: number): number {
	// Verified against `aspire dashboard run --help` (aspire CLI, May 2026):
	//   --frontend-url, --otlp-grpc-url, --otlp-http-url, --allow-anonymous, --non-interactive
	const args = [
		"dashboard",
		"run",
		"--allow-anonymous",
		"--non-interactive",
		"--frontend-url",
		`http://localhost:${UI_PORT}`,
		"--otlp-grpc-url",
		`http://localhost:${OTLP_GRPC_PORT}`,
		"--otlp-http-url",
		`http://localhost:${OTLP_HTTP_PORT}`,
	];
	const child = spawn("aspire", args, {
		stdio: ["ignore", logFd, logFd],
		detached: true,
		windowsHide: true,
	});
	child.unref();
	if (!child.pid) throw new Error("failed to spawn aspire");
	return child.pid;
}

function spawnContainer(driver: "docker" | "podman", logFd: number): number {
	// Remove any stale container with the same name (best-effort).
	spawnSync(driver, ["rm", "-f", DOCKER_CONTAINER], { stdio: "ignore" });

	const args = [
		"run",
		"--rm",
		"--name",
		DOCKER_CONTAINER,
		"-p",
		`${UI_PORT}:${UI_PORT}`,
		"-p",
		`${OTLP_GRPC_PORT}:${OTLP_GRPC_PORT}`,
		"-p",
		`${OTLP_HTTP_PORT}:${OTLP_HTTP_PORT}`,
		"-e",
		"ASPIRE_DASHBOARD_UNSECURED_ALLOW_ANONYMOUS=true",
		"mcr.microsoft.com/dotnet/aspire-dashboard:latest",
	];
	const child = spawn(driver, args, {
		stdio: ["ignore", logFd, logFd],
		detached: true,
		windowsHide: true,
	});
	child.unref();
	if (!child.pid) throw new Error(`failed to spawn ${driver}`);
	return child.pid;
}

async function isRunning(): Promise<boolean> {
	const meta = readMeta();
	if (meta && pidAlive(meta.pid) && (await probePort(OTLP_GRPC_PORT))) return true;
	// pidfile stale but port open (manual aspire/docker) → treat as running
	if (await probePort(OTLP_GRPC_PORT)) return true;
	return false;
}

type Notify = (msg: string, level?: "info" | "error") => void;

async function startCmd(notify: Notify, forceDriver: Driver | undefined): Promise<void> {
	ensureDir();

	if (await isRunning()) {
		notify(`Aspire dashboard already running → ${UI_URL}`);
		return;
	}

	// Pre-check: port conflict from an unrelated process.
	if (await probePort(OTLP_GRPC_PORT)) {
		notify(`Port ${OTLP_GRPC_PORT} is in use by another process. Free it or change ports.`, "error");
		return;
	}
	if (await probePort(UI_PORT)) {
		notify(`Port ${UI_PORT} is in use by another process. Free it or change ports.`, "error");
		return;
	}

	const driver = forceDriver ?? detectDriver();
	if (!driver) {
		notify(noDriverMessage(), "error");
		return;
	}

	// Truncate the log so failure tails are scoped to this run.
	writeFileSync(LOG_FILE, "");
	const logFd = openSync(LOG_FILE, "a");

	let pid: number;
	try {
		if (driver === "aspire") {
			pid = spawnAspire(logFd);
		} else {
			pid = spawnContainer(driver, logFd);
		}
	} catch (e: any) {
		notify(`Failed to spawn ${driver}: ${e?.message ?? e}`, "error");
		return;
	}

	writeMeta({ driver, pid, startedAt: new Date().toISOString() });

	const up = await waitForPort(OTLP_GRPC_PORT, 5000);
	if (!up) {
		notify(
			[
				`Aspire dashboard (driver=${driver}) did not become ready on port ${OTLP_GRPC_PORT} within 5s.`,
				"--- log tail ---",
				tailLog(),
			].join("\n"),
			"error",
		);
		return;
	}

	notify(
		[
			`Aspire dashboard started (driver=${driver}, pid=${pid}).`,
			`UI:        ${UI_URL}`,
			`OTLP gRPC: http://localhost:${OTLP_GRPC_PORT}`,
			`OTLP HTTP: http://localhost:${OTLP_HTTP_PORT}`,
		].join("\n"),
	);
}

async function stopCmd(notify: Notify): Promise<void> {
	const meta = readMeta();
	if (!meta) {
		notify("Aspire dashboard is not running (no pidfile).");
		return;
	}

	if (meta.driver === "docker" || meta.driver === "podman") {
		const r = spawnSync(meta.driver, ["stop", DOCKER_CONTAINER], { stdio: "ignore" });
		if (r.status !== 0) {
			// fall back to PID kill of the client
			if (pidAlive(meta.pid)) killPid(meta.pid);
		}
	} else {
		if (pidAlive(meta.pid)) killPid(meta.pid);
	}

	// Give it a moment to release the port.
	for (let i = 0; i < 10; i++) {
		if (!(await probePort(OTLP_GRPC_PORT))) break;
		await new Promise((r) => setTimeout(r, 200));
	}

	clearMeta();
	notify(`Aspire dashboard stopped (driver=${meta.driver}).`);
}

function splitArgs(s: string): string[] {
	return s.trim().split(/\s+/).filter(Boolean);
}

function parseEndpoint(endpoint: string): { host: string; port: number } | null {
	// Accept "host:port", "http(s)://host:port", or "http(s)://host:port/path".
	let raw = endpoint.trim();
	if (!raw) return null;
	if (!/^https?:\/\//i.test(raw)) raw = `http://${raw}`;
	let u: URL;
	try {
		u = new URL(raw);
	} catch {
		return null;
	}
	const host = u.hostname;
	const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
	if (!host || !Number.isFinite(port)) return null;
	return { host, port };
}

async function connectCmd(
	notify: Notify,
	endpoint: string,
	protocol: Protocol,
	emit: (payload: { endpoint: string; protocol: Protocol }) => void,
): Promise<void> {
	const parsed = parseEndpoint(endpoint);
	if (!parsed) {
		notify(`Could not parse endpoint: ${endpoint}`, "error");
		return;
	}
	const reachable = await new Promise<boolean>((resolve) => {
		const sock = createConnection({ port: parsed.port, host: parsed.host });
		const done = (ok: boolean) => {
			sock.destroy();
			resolve(ok);
		};
		sock.setTimeout(1500);
		sock.once("connect", () => done(true));
		sock.once("timeout", () => done(false));
		sock.once("error", () => done(false));
	});
	if (!reachable) {
		notify(
			`OTLP endpoint ${endpoint} (${parsed.host}:${parsed.port}) is not reachable. Start a collector first, or pass a different endpoint.`,
			"error",
		);
		return;
	}
	emit({ endpoint, protocol });
	notify(`pi-otel connected → ${endpoint} (protocol=${protocol}).`);
}

export function registerOtelCommand(pi: ExtensionAPI): void {
	pi.registerCommand("otel", {
		description: "Aspire OTel dashboard launcher: start | stop | connect",
		getArgumentCompletions: (prefix) => {
			return SUBCOMMANDS.filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s }));
		},
		handler: async (args, ctx) => {
			const tokens = splitArgs(args);
			const sub = (tokens[0] || "") as Sub | "";
			const notify: Notify = (m, l = "info") => ctx.ui.notify(m, l);

			if (sub === "start") {
				// optional override: /otel start --driver=docker
				const drvArg = tokens.find((t) => t.startsWith("--driver="));
				const forced = drvArg?.split("=")[1] as Driver | undefined;
				if (forced && !["aspire", "docker", "podman"].includes(forced)) {
					notify(`Unknown driver: ${forced}. Use aspire|docker|podman.`, "error");
					return;
				}
				await startCmd(notify, forced);
				pi.events.emit("pi-otel:dashboard-ready", {
					endpoint: `http://localhost:${OTLP_GRPC_PORT}`,
				});
				return;
			}

			if (sub === "stop") {
				await stopCmd(notify);
				pi.events.emit("pi-otel:dashboard-stopped", {});
				return;
			}

			if (sub === "connect") {
				const positional = tokens.slice(1).filter((t) => !t.startsWith("--"));
				const endpoint = positional[0] ?? DEFAULT_CONNECT_ENDPOINT;
				const protoArg = tokens.find((t) => t.startsWith("--protocol="));
				const protocol = (protoArg?.split("=")[1] ?? DEFAULT_CONNECT_PROTOCOL) as Protocol;
				if (!(PROTOCOLS as readonly string[]).includes(protocol)) {
					notify(`Unknown protocol: ${protocol}. Use ${PROTOCOLS.join("|")}.`, "error");
					return;
				}
				await connectCmd(notify, endpoint, protocol, (payload) =>
					pi.events.emit("pi-otel:dashboard-ready", payload),
				);
				return;
			}

			notify(
				[
					"Usage: /otel <command>",
					"",
					"  start [--driver=aspire|docker|podman]   Start the Aspire dashboard",
					"  stop                                    Stop the Aspire dashboard",
					"  connect [endpoint] [--protocol=grpc|http/protobuf|http/json]",
					"                                          Re-wire pi-otel to an existing OTLP endpoint",
					"                                          (default: http://localhost:4317, grpc)",
					"",
					`State dir: ${OTEL_DIR}`,
				].join("\n"),
				sub ? "error" : "info",
			);
		},
	});
}
