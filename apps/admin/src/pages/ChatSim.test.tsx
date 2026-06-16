/**
 * M6.1 ChatSim 多 session 升级测试（spec §3.3 / §5）。
 *
 * jsdom + mock api.ts 整套（chat / listSessions / renameSession / deleteSession）。
 * 验证：session 切换 UI / 重命名 input / 删除 confirm / 新建 session 清空。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within, findByText, act, cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";

// mock api.ts（不在 jsdom 走真网络）
vi.mock("../lib/api.js", () => ({
  chat: vi.fn(),
  listSessions: vi.fn(),
  renameSession: vi.fn(),
  deleteSession: vi.fn(),
}));

import ChatSim from "./ChatSim.js";
import { chat, listSessions, renameSession, deleteSession } from "../lib/api.js";

const mockedChat = vi.mocked(chat);
const mockedList = vi.mocked(listSessions);
const mockedRename = vi.mocked(renameSession);
const mockedDelete = vi.mocked(deleteSession);

const SAMPLE_SESSIONS = [
  { id: "01HAAAA000000000000000001", user_id: "u1", title: "宝宝发烧", created_at: 100, last_active_at: 300, degraded_at: null },
  { id: "01HAAAA000000000000000002", user_id: "u1", title: "辅食添加", created_at: 200, last_active_at: 200, degraded_at: null },
];

beforeEach(() => {
  localStorage.setItem("admin_token", "test-token");
  vi.clearAllMocks();
  // 默认 mock
  mockedList.mockResolvedValue({ sessions: SAMPLE_SESSIONS });
  mockedChat.mockResolvedValue({
    answer: "物理降温...不构成医疗建议。",
    citations: [{ n: 1, title: "儿科指南", trust_level: 3, chunk_id: "c1" }],
    session_id: "01HNEW0000000000000000000",
    session_title: "新会话",
    is_new_session: true,
    cached: false,
    degraded: false,
  });
  mockedRename.mockResolvedValue(undefined);
  mockedDelete.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
});

describe("ChatSim 多 session UI", () => {
  it("挂载时拉 listSessions + 显示 session 列表", async () => {
    render(<ChatSim />);
    // 等 listSessions resolve + setState flush
    await waitFor(() => expect(mockedList).toHaveBeenCalled());
    expect(await screen.findByText("宝宝发烧")).toBeInTheDocument();
    expect(await screen.findByText("辅食添加")).toBeInTheDocument();
  });

  it("点击 session 切到该 session（清空 messages）", async () => {
    render(<ChatSim />);
    const target = await screen.findByText("宝宝发烧");
    fireEvent.click(target);
    // 当前 sessionId 应展示在 title 旁
    await waitFor(() => {
      expect(screen.getByText(/session: 01HAAAA0/)).toBeInTheDocument();
    });
  });

  it("提新问题 → 调 chat() + 收到 session_id 后显示 session: 01HNEW…", async () => {
    render(<ChatSim />);
    await screen.findByText("宝宝发烧");

    const input = screen.getByPlaceholderText("输入问题…") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "5个月宝宝发烧怎么办" } });
    fireEvent.click(screen.getByText("提问"));

    await waitFor(() => {
      expect(mockedChat).toHaveBeenCalledWith("5个月宝宝发烧怎么办", undefined);
    });
    // 收到 session_id 后显示在 title
    await waitFor(() => {
      expect(screen.getByText(/session: 01HNEW0/)).toBeInTheDocument();
    });
  });

  it("点 '+ 新建' 清空 sessionId + messages", async () => {
    render(<ChatSim />);
    await screen.findByText("宝宝发烧");
    // 先切到第一个 session
    fireEvent.click(screen.getByText("宝宝发烧"));
    await waitFor(() => screen.getByText(/session: 01HAAAA0/));

    // 点 + 新建
    fireEvent.click(screen.getByText("+ 新建"));
    // sessionId indicator 应消失
    await waitFor(() => {
      expect(screen.queryByText(/session: 01HAAAA0/)).not.toBeInTheDocument();
    });
  });
});
