import { useEffect, useState } from "react";

interface FallbackState {
  consecutiveFailures: number;
  totalFailures: number;
  disabled: boolean;
}

interface LlmStatusResponse {
  omlx: {
    available: boolean;
    url: string;
    models: string[];
    error?: string;
  };
  fallback: {
    embed: FallbackState;
    llm: FallbackState;
  };
}

type ChipTone = "green" | "red" | "yellow" | "gray";

interface ChipInfo {
  tone: ChipTone;
  label: string;
  detail?: string;
}

/**
 * LlmStatus — admin UI 上的本地 LLM / embedding 状态 chip
 *
 * 30s 轮询 /api/llm-status
 * chip 颜色逻辑：
 *   - green: OMLX 在线 + 无失败
 *   - red:   3+ 连续失败（fallback 用云端）
 *   - yellow: 累计 5+ 失败（永久禁用本地）
 *   - gray:  OMLX 离线
 */
export function LlmStatus() {
  const [status, setStatus] = useState<LlmStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch("/api/llm-status");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as LlmStatusResponse;
        if (!cancelled) {
          setStatus(data);
          setLoading(false);
        }
      } catch (e) {
        if (!cancelled) {
          setErr(e instanceof Error ? e.message : String(e));
          setLoading(false);
        }
      }
    };
    void tick();
    const id = setInterval(() => { void tick(); }, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (loading) {
    return (
      <div className="inline-flex items-center gap-1 rounded border border-gray-300 bg-white px-2 py-0.5 text-xs text-gray-500" data-testid="llm-status">
        <span className="h-2 w-2 animate-pulse rounded-full bg-gray-400" />
        加载中…
      </div>
    );
  }
  if (err) {
    return (
      <div className="inline-flex items-center gap-1 rounded border border-red-300 bg-red-50 px-2 py-0.5 text-xs text-red-700" data-testid="llm-status">
        LLM 状态查询失败
      </div>
    );
  }
  if (!status) return null;

  const embed = computeChip(status.omlx.available, status.fallback.embed);
  const llm = computeChip(status.omlx.available, status.fallback.llm);

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs" data-testid="llm-status">
      <Chip info={llm} labelPrefix="LLM" component="llm" />
      <Chip info={embed} labelPrefix="Embed" component="embed" />
      {status.omlx.available && status.omlx.models.length > 0 && (
        <span className="text-gray-400">
          模型: {status.omlx.models.slice(0, 3).join(", ")}
          {status.omlx.models.length > 3 && ` +${status.omlx.models.length - 3}`}
        </span>
      )}
    </div>
  );
}

function Chip({ info, labelPrefix, component }: {
  info: ChipInfo;
  labelPrefix: string;
  component: "llm" | "embed";
}) {
  const dotColor: Record<ChipTone, string> = {
    green: "bg-green-500",
    red: "bg-red-500",
    yellow: "bg-yellow-500",
    gray: "bg-gray-400",
  };
  const cls: Record<ChipTone, string> = {
    green: "border-green-300 bg-green-50 text-green-800",
    red: "border-red-300 bg-red-50 text-red-800",
    yellow: "border-yellow-300 bg-yellow-50 text-yellow-800",
    gray: "border-gray-300 bg-gray-50 text-gray-700",
  };
  return (
    <span
      title={info.detail ?? info.label}
      className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 ${cls[info.tone]}`}
      data-testid={`chip-${component}`}
    >
      <span className={`h-2 w-2 rounded-full ${dotColor[info.tone]}`} />
      {labelPrefix}: {info.label}
    </span>
  );
}

function computeChip(omlxAvailable: boolean, fb: FallbackState): ChipInfo {
  if (fb.disabled) {
    return {
      tone: "yellow",
      label: "已禁用",
      detail: `累计失败 ${fb.totalFailures} 次，本地 ${fb.disabled ? "永久禁用" : ""}`,
    };
  }
  if (fb.consecutiveFailures >= 3) {
    return {
      tone: "red",
      label: "Fallback 云端",
      detail: `连续失败 ${fb.consecutiveFailures} 次`,
    };
  }
  if (!omlxAvailable) {
    return {
      tone: "gray",
      label: "离线",
      detail: "OMLX 未运行",
    };
  }
  return {
    tone: "green",
    label: "本地 ✓",
    detail: fb.consecutiveFailures > 0 ? `${fb.consecutiveFailures} 次连续失败` : "运行中",
  };
}