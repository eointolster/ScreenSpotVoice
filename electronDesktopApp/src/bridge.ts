import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

export class PythonBridge {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private lastError = '';

  constructor(private readonly projectRoot: string) {}

  get ready() { return existsSync(join(this.projectRoot, '.venv', 'bin', 'python')); }

  private launch() {
    if (this.child && this.child.exitCode === null && !this.child.killed) return;
    if (!this.ready) throw new Error('Python voice environment is missing. Run ./setup.sh in electronDesktopApp.');
    const executable = join(this.projectRoot, '.venv', 'bin', 'python');
    const child = spawn(executable, ['-u', '-m', 'voice.worker'], {
      cwd: this.projectRoot,
      env: { ...process.env, HF_HOME: join(this.projectRoot, '.cache', 'huggingface'), PYTHONUNBUFFERED: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    createInterface({ input: child.stdout }).on('line', line => {
      let data: any;
      try { data = JSON.parse(line); } catch { return; }
      const pending = this.pending.get(data.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(data.id);
      if (data.ok) pending.resolve(data);
      else pending.reject(new Error(String(data.error || 'Voice worker failed')));
    });
    child.stderr.on('data', chunk => {
      const message = String(chunk).trim();
      if (message) this.lastError = message.slice(-700);
    });
    child.on('error', error => this.failAll(error));
    child.on('exit', code => {
      if (this.child !== child) return;
      this.child = null;
      this.failAll(new Error(`Voice worker exited (${code ?? 'signal'}). ${this.lastError}`));
    });
  }

  request(action: string, payload: Record<string, unknown>, timeoutMs = 120000): Promise<any> {
    this.launch();
    const child = this.child!;
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.restart();
        reject(new Error(`${action} timed out after ${Math.round(timeoutMs / 1000)} seconds`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id, action, ...payload }) + '\n', error => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  private failAll(error: Error) {
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear();
  }

  restart() {
    const old = this.child;
    this.child = null;
    this.failAll(new Error('Session stopped'));
    old?.kill();
  }

  close() { this.restart(); }
}
