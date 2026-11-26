import { type AgentType, type Config, configuredAgents } from "../config.js";
import type { Agent, AgentRegistry } from "../core/types.js";
import { createAgyAgent } from "./agy.js";
import { createCodexAgent } from "./codex.js";

/** 按类型初始化单个 Agent 适配器；业务核心层只依赖 Agent 接口。 */
export function createAgent(type: AgentType, path: string): Promise<Agent> {
  switch (type) {
    case "codex":
      return createCodexAgent(path);
    case "agy":
      return createAgyAgent(path);
  }
}

/** 并发初始化配置中的所有 Agent，并返回供核心层按标识路由与切换的注册表。 */
export async function createAgentRegistry(config: Config): Promise<AgentRegistry> {
  const entries = configuredAgents(config);
  const loaded = await Promise.all(
    entries.map(async ({ type, path }) => {
      try {
        return [type, await createAgent(type, path)] as const;
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          throw Object.assign(error, { agentType: type, agentPath: path });
        }
        throw error;
      }
    }),
  );
  const map = new Map<string, Agent>(loaded);
  const defaultId = config.defaultAgent;
  const fallback = map.get(defaultId);
  if (!fallback) throw new Error(`Default agent "${defaultId}" not initialized.`);

  return {
    defaultId,
    list: () =>
      loaded.map(([id, agent]) => ({
        id,
        label: agent.unavailableReason
          ? `${agent.name} (unavailable)`
          : `${agent.name} (${agent.version})`,
      })),
    has: (id) => map.has(id),
    get: (id) => (id ? map.get(id) : undefined),
    resolve: (id) => (id ? map.get(id) : undefined) ?? fallback,
    all: () => [...map.values()],
  };
}
