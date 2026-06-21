/**
 * CP-7-C: FallbackDetector — OMLX 失败计数 + 切云端
 *
 * 规则（spec §5.2）：
 * - 连续 3 次失败 → shouldDisableLocal = true（切云端）
 * - 成功 → 重置计数
 * - 累计 5 次失败 → shouldDisable = permanent（永久禁用 + 警告）
 *
 * 每个 component (embed/llm) 独立计数
 */

export type FallbackComponent = "embed" | "llm";

interface ComponentState {
  consecutiveFailures: number;
  totalFailures: number;
  totalSuccesses: number;
  disabled: boolean;          // 永久禁用（> 5 次累计失败）
  warning: boolean;            // > 3 次连续失败警告
}

export class FallbackDetector {
  private state: Map<FallbackComponent, ComponentState> = new Map();

  private get(c: FallbackComponent): ComponentState {
    let s = this.state.get(c);
    if (!s) {
      s = {
        consecutiveFailures: 0,
        totalFailures: 0,
        totalSuccesses: 0,
        disabled: false,
        warning: false,
      };
      this.state.set(c, s);
    }
    return s;
  }

  recordSuccess(component: FallbackComponent): void {
    const s = this.get(component);
    s.consecutiveFailures = 0;
    s.totalSuccesses++;
  }

  recordFailure(component: FallbackComponent): { shouldDisable: boolean; isPermanent: boolean } {
    const s = this.get(component);
    s.consecutiveFailures++;
    s.totalFailures++;
    // spec: 累计 5 次 → permanent disable
    if (s.totalFailures >= 5) {
      s.disabled = true;
    }
    // spec: 3 次连续失败 → shouldDisable = true（临时切云端）
    const shouldDisable = s.consecutiveFailures >= 3;
    s.warning = s.consecutiveFailures >= 3;
    return { shouldDisable, isPermanent: s.disabled };
  }

  shouldUseCloud(component: FallbackComponent): boolean {
    const s = this.get(component);
    if (s.disabled) return true;       // 永久禁用 → 永远云端
    if (s.consecutiveFailures >= 3) return true;  // 临时切云端
    return false;                      // 本地 OK
  }

  getState(component: FallbackComponent): ComponentState {
    return { ...this.get(component) };
  }

  reset(component?: FallbackComponent): void {
    if (component) {
      this.state.delete(component);
    } else {
      this.state.clear();
    }
  }
}
