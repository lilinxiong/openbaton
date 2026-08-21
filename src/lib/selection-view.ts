import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { SelectionCandidate, SelectionProposal, SelectionUnit } from "./selection.js";
import type { SelectionQuotaPool } from "./quota-pools.js";

export const SELECTION_PRESENTATION = "current_conversation_inline_only" as const;
export const SELECTION_INLINE_REFERENCE_KIND = "visualize" as const;

export interface SelectionViewArtifact {
  output: string;
  presentation: typeof SELECTION_PRESENTATION;
  surface: "current_conversation";
  display_language: "zh-CN";
  inline_content_reference: string;
  content_reference: {
    kind: typeof SELECTION_INLINE_REFERENCE_KIND;
    path: string;
  };
  host_action: "emit_inline_content_reference_in_current_response";
  browser_navigation_allowed: false;
  file_link_allowed: false;
}

interface ViewCandidate extends SelectionCandidate {
  scores: Record<string, number | null>;
  preferred_for: string[];
  display_model_id: string;
}

export interface SelectionViewOptions {
  taskLabels?: Record<string, string>;
  suggestedAssignments?: Record<string, string>;
  viewId?: string;
  source?: "standalone" | "openspec" | "bundle";
  confirmationId?: string;
  confirmationScope?: "proposal" | "bundle";
  approvalTargets?: SelectionViewApprovalTarget[];
}

export interface SelectionViewApprovalTarget {
  scope: string;
  cwd: string | null;
  proposal_id: string;
  source: "standalone" | "openspec";
  units: Array<{ view_key: string; source_key: string }>;
}

export interface SelectionBundleInput {
  scope: string;
  cwd: string;
  proposal: SelectionProposal;
  taskLabels?: Record<string, string>;
  suggestedAssignments?: Record<string, string>;
}

function safeJson(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

function displayModelId(candidate: SelectionCandidate): string {
  const route = candidate.route_id.includes("/")
    ? candidate.route_id.split("/").slice(1).join("/")
    : candidate.route_id;
  return candidate.reasoning_effort ? `${route}@${candidate.reasoning_effort}` : route;
}

function providerOptions(pools: SelectionQuotaPool[], candidates: ViewCandidate[]) {
  const providers = new Map<string, { id: string; pool_ids: string[]; selectable: boolean; model_count: number; selectable_model_count: number }>();
  const selectable = new Set(candidates.filter((candidate) => candidate.selectable).map((candidate) => candidate.provider || "unknown"));
  for (const pool of pools) {
    const current = providers.get(pool.provider) || { id: pool.provider, pool_ids: [], selectable: false, model_count: 0, selectable_model_count: 0 };
    current.pool_ids.push(pool.id);
    current.model_count += pool.model_ids.length;
    current.selectable_model_count += pool.model_ids.filter((modelId) => candidates.find((candidate) => candidate.model_id === modelId)?.selectable).length;
    current.selectable ||= selectable.has(pool.provider);
    providers.set(pool.provider, current);
  }
  return [...providers.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function viewState(proposal: SelectionProposal, options: SelectionViewOptions = {}) {
  const visibleModels = new Set(proposal.quota_pools.flatMap((pool) => pool.model_ids));
  const units = proposal.units.filter((unit) => !unit.director_local).map((unit) => {
    const metadata = unit.metadata || {};
    return {
      key: unit.key,
      source_key: typeof metadata.source_key === "string" ? metadata.source_key : unit.key,
      scope: typeof metadata.view_scope === "string" ? metadata.view_scope : proposal.source,
      source: metadata.view_source === "standalone" || metadata.view_source === "openspec" ? metadata.view_source : proposal.source,
      description: options.taskLabels?.[unit.key] || unit.description,
      recommended_model_id: unit.recommended_model_id,
      recommendation_reason: unit.recommendation_reason,
      target_reasoning_effort: unit.target_reasoning_effort,
      complexity_reason: unit.complexity_reason,
      estimated_context_tokens: unit.estimated_context_tokens,
      context_estimate_reason: unit.context_estimate_reason,
      requires_manual_choice: unit.requires_manual_choice,
      default_model_id: unit.default_model_id && visibleModels.has(unit.default_model_id) ? unit.default_model_id : null,
      available_model_ids: unit.candidates
        .filter((candidate) => candidate.selectable && visibleModels.has(candidate.model_id))
        .map((candidate) => candidate.model_id),
    };
  });
  const candidates = new Map<string, ViewCandidate>();
  for (const unit of proposal.units) {
    if (unit.director_local) continue;
    for (const candidate of unit.candidates) {
      if (!visibleModels.has(candidate.model_id)) continue;
      const existing = candidates.get(candidate.model_id);
      if (!existing) {
        candidates.set(candidate.model_id, {
          ...structuredClone(candidate),
          display_model_id: displayModelId(candidate),
          scores: { [unit.key]: candidate.task_score },
          preferred_for: candidate.model_id === unit.recommended_model_id ? [unit.key] : [],
        });
        continue;
      }
      existing.selectable ||= candidate.selectable;
      existing.automatic_eligible ||= candidate.automatic_eligible;
      existing.scores[unit.key] = candidate.task_score;
      if (candidate.model_id === unit.recommended_model_id) existing.preferred_for.push(unit.key);
    }
  }
  const candidateList = [...candidates.values()];
  const taskMax = Object.fromEntries(units.map((unit) => {
    const values = candidateList.map((candidate) => candidate.scores[unit.key]).filter((value): value is number => typeof value === "number");
    return [unit.key, values.length ? Math.max(...values) : null];
  }));
  const unitKeys = new Set(units.map((unit) => unit.key));
  const suggestedAssignments = options.suggestedAssignments || {};
  for (const [key, modelId] of Object.entries(suggestedAssignments)) {
    if (!unitKeys.has(key)) throw new Error(`INVALID_SELECTION_SUGGESTION: ${key} is not a delegable unit in ${proposal.id}`);
    const unit = units.find((item) => item.key === key)!;
    const candidate = candidates.get(modelId);
    if (!candidate || !unit.available_model_ids.includes(modelId)) {
      throw new Error(`INVALID_SELECTION_SUGGESTION: ${key}=${modelId} was not disclosed as selectable in ${proposal.id}`);
    }
  }
  const defaultAssignments = Object.fromEntries(units.map((unit) => [
    unit.key,
    suggestedAssignments[unit.key] || unit.default_model_id || "",
  ]));
  const defaultProviders = [...new Set(Object.values(defaultAssignments)
    .map((modelId) => candidates.get(modelId)?.provider || null)
    .filter((provider): provider is string => Boolean(provider)))].sort();
  const approvalTargets = options.approvalTargets || [{
    scope: proposal.source,
    cwd: null,
    proposal_id: proposal.id,
    source: proposal.source,
    units: units.map((unit) => ({ view_key: unit.key, source_key: unit.source_key })),
  }];
  return {
    view_id: options.viewId || proposal.id,
    proposal_id: proposal.id,
    proposal_ids: approvalTargets.map((target) => target.proposal_id),
    source: options.source || proposal.source,
    confirmation_id: options.confirmationId || `confirmation-${proposal.id}`,
    confirmation_scope: options.confirmationScope || "proposal",
    approval_targets: approvalTargets,
    catalog_fingerprint: proposal.catalog_fingerprint,
    units,
    task_max: taskMax,
    candidates: candidateList,
    quota_pools: proposal.quota_pools,
    providers: providerOptions(proposal.quota_pools, candidateList),
    task_exclusions: proposal.task_exclusions,
    policy_exclusions: proposal.policy_exclusions,
    has_suggestions: Object.values(defaultAssignments).some(Boolean),
    default_checked: [...new Set(Object.values(defaultAssignments).filter((value): value is string => Boolean(value)))],
    default_assignments: defaultAssignments,
    default_providers: defaultProviders,
  };
}

function mergeQuotaPools(inputs: SelectionBundleInput[]): SelectionQuotaPool[] {
  const pools = new Map<string, SelectionQuotaPool>();
  const rank = { available: 0, unknown: 1, exhausted: 2 } as const;
  for (const input of inputs) {
    for (const pool of input.proposal.quota_pools) {
      const current = pools.get(pool.id);
      if (!current) {
        pools.set(pool.id, structuredClone(pool));
        continue;
      }
      current.model_ids = [...new Set([...current.model_ids, ...pool.model_ids])].sort();
      if (rank[pool.status] > rank[current.status]) current.status = pool.status;
      current.selectable ||= pool.selectable;
      const remaining = [current.remaining_percent, pool.remaining_percent].filter((value): value is number => typeof value === "number");
      current.remaining_percent = remaining.length ? Math.min(...remaining) : null;
      current.source = [...new Set([current.source, pool.source].filter((value): value is string => Boolean(value)))].join(" + ") || null;
      current.observed_at = [current.observed_at, pool.observed_at].sort().at(-1)!;
      current.reason = [...new Set([current.reason, pool.reason].filter((value): value is string => Boolean(value)))].join(" + ") || null;
      current.reverse_engineered ||= pool.reverse_engineered;
      const windows = new Map(current.windows.map((window) => [`${window.name}\u0000${window.label}`, window]));
      for (const window of pool.windows) {
        const key = `${window.name}\u0000${window.label}`;
        const existing = windows.get(key);
        if (!existing || window.remaining_percent < existing.remaining_percent) windows.set(key, structuredClone(window));
      }
      current.windows = [...windows.values()];
    }
  }
  return [...pools.values()].sort((left, right) => rank[left.status] - rank[right.status]
    || (right.remaining_percent ?? -1) - (left.remaining_percent ?? -1)
    || left.label.localeCompare(right.label));
}

function bundleProposal(inputs: SelectionBundleInput[]) {
  if (inputs.length < 2) throw new Error("SELECTION_BUNDLE_REQUIRES_MULTIPLE_PROPOSALS");
  const scopes = new Set<string>();
  const fingerprints = new Set<string>();
  const policies = new Set<string>();
  const units: SelectionUnit[] = [];
  const taskLabels: Record<string, string> = {};
  const suggestedAssignments: Record<string, string> = {};
  const approvalTargets: SelectionViewApprovalTarget[] = [];
  for (const input of inputs) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(input.scope)) throw new Error(`INVALID_SELECTION_BUNDLE_SCOPE: ${input.scope}`);
    if (scopes.has(input.scope)) throw new Error(`DUPLICATE_SELECTION_BUNDLE_SCOPE: ${input.scope}`);
    scopes.add(input.scope);
    if (input.proposal.status !== "pending_confirmation") throw new Error(`selection proposal ${input.proposal.id} is already ${input.proposal.status}`);
    fingerprints.add(input.proposal.catalog_fingerprint);
    policies.add(input.proposal.model_policy_id);
    const targetUnits: SelectionViewApprovalTarget["units"] = [];
    for (const unit of input.proposal.units) {
      if (unit.director_local) continue;
      const viewKey = `${input.scope}/${unit.key}`;
      const label = input.taskLabels?.[unit.key];
      const assignment = input.suggestedAssignments?.[unit.key];
      units.push({
        ...structuredClone(unit),
        key: viewKey,
        metadata: {
          ...structuredClone(unit.metadata || {}),
          view_scope: input.scope,
          view_source: input.proposal.source,
          source_key: unit.key,
        },
      });
      if (label) taskLabels[viewKey] = label;
      if (assignment) suggestedAssignments[viewKey] = assignment;
      targetUnits.push({ view_key: viewKey, source_key: unit.key });
    }
    approvalTargets.push({
      scope: input.scope,
      cwd: path.resolve(input.cwd),
      proposal_id: input.proposal.id,
      source: input.proposal.source,
      units: targetUnits,
    });
  }
  if (fingerprints.size !== 1) throw new Error("SELECTION_BUNDLE_CATALOG_MISMATCH: refresh and recreate every proposal from one OpenCodex catalog snapshot");
  if (policies.size !== 1) throw new Error("SELECTION_BUNDLE_POLICY_MISMATCH: recreate every proposal under the current model policy");
  const seed = inputs.map((input) => `${input.scope}:${path.resolve(input.cwd)}#${input.proposal.id}`).sort().join("\n");
  const suffix = crypto.createHash("sha256").update(seed).digest("hex").slice(0, 16);
  const id = `bundle-${suffix}`;
  const quotaPools = mergeQuotaPools(inputs);
  const taskExclusions = [...new Map(inputs.flatMap((input) => input.proposal.task_exclusions)
    .map((item) => [`${item.model_id}\u0000${item.route_id}\u0000${item.code}`, item])).values()];
  const policyExclusions = [...new Map(inputs.flatMap((input) => input.proposal.policy_exclusions)
    .map((item) => [item.family, structuredClone(item)])).values()];
  const createdAt = inputs.map((input) => input.proposal.created_at).sort()[0];
  const proposal: SelectionProposal = {
    schema_version: 2,
    id,
    status: "pending_confirmation",
    source: "standalone",
    created_at: createdAt,
    approved_at: null,
    catalog_fingerprint: [...fingerprints][0],
    source_fingerprint: crypto.createHash("sha256").update(seed).digest("hex"),
    model_policy_id: [...policies][0],
    units,
    quota_pools: quotaPools,
    task_exclusions: taskExclusions,
    policy_exclusions: policyExclusions,
    payload: { source_shape: "selection-bundle-v1" },
    confirmation: null,
    approvals: [],
    history: [{ event: "pending_confirmation", at: createdAt }],
  };
  return {
    proposal,
    options: {
      taskLabels,
      suggestedAssignments,
      viewId: id,
      source: "bundle" as const,
      confirmationId: `confirmation-${id}`,
      confirmationScope: "bundle" as const,
      approvalTargets,
    },
  };
}

export function renderSelectionView(proposal: SelectionProposal, options: SelectionViewOptions = {}): string {
  const state = viewState(proposal, options);
  const rootId = `baton-selection-${state.view_id.replaceAll(/[^a-zA-Z0-9_-]/g, "-")}`;
  return `<div id="${rootId}" data-baton-presentation="${SELECTION_PRESENTATION}">
  <style>
    #${rootId} .baton-heading,#${rootId} .baton-step-heading,#${rootId} .baton-pool-summary,#${rootId} .baton-submit-row{display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap}
    #${rootId} .baton-flow,#${rootId} .baton-pools,#${rootId} .baton-providers{display:grid;gap:18px}
    #${rootId} .baton-pools,#${rootId} .baton-providers{gap:12px}
    #${rootId} .baton-providers{grid-template-columns:repeat(auto-fit,minmax(210px,1fr))}
    #${rootId} .baton-provider{display:flex;align-items:center;gap:10px;margin:0}
    #${rootId} .baton-section{margin-top:20px}
    #${rootId} .baton-pool{margin:0}
    #${rootId} .baton-pool>summary{cursor:pointer}
    #${rootId} .baton-pool-quota{text-align:right}
    #${rootId} .baton-provider-inactive{opacity:.62}
    #${rootId} .baton-pool-exhausted{opacity:.62;filter:saturate(.35)}
    #${rootId} .baton-table{margin-top:10px}
    #${rootId} .baton-table th,#${rootId} .baton-table td{vertical-align:middle}
    #${rootId} .baton-route{max-width:250px;overflow-wrap:anywhere;text-align:left}
    #${rootId} .baton-detail-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(185px,1fr));gap:12px}
    #${rootId} .baton-detail-grid>div{min-width:0}
    #${rootId} tr[data-checked="true"]{box-shadow:inset 3px 0 0 var(--primary)}
    #${rootId} .baton-excluded{columns:2;column-gap:24px}
    #${rootId} .baton-excluded li{break-inside:avoid}
    @media(max-width:620px){#${rootId} .baton-heading,#${rootId} .baton-pool-summary{display:block}#${rootId} .baton-pool-quota{margin-top:6px;text-align:left}#${rootId} .baton-route{max-width:180px}#${rootId} .baton-excluded{columns:1}}
  </style>
  <div class="baton-heading">
    <h2>Baton 汇总模型选择</h2>
    <span class="text-small text-muted">一次询问 · 一次汇总 · 一次 Submit · 提交前 0 ticket / 0 subagent</span>
  </div>
  <div class="viz-grid">
    <div class="card viz-stat"><div class="text-muted">全局 Provider</div><div class="viz-stat-value" data-provider-count></div><div class="text-small">一个总选项，可多选</div></div>
    <div class="card viz-stat"><div class="text-muted">可选择候选 route/profile</div><div class="viz-stat-value" data-model-count></div><div class="text-small">来自 Baton 按需同步的 OpenCodex 可执行 route snapshot</div></div>
    <div class="card viz-stat"><div class="text-muted">已勾选 exact route</div><div class="viz-stat-value" data-checked-count></div><div class="text-small">禁止 silent fallback</div></div>
  </div>
  <div class="baton-flow baton-section">
    <section>
      <div class="baton-step-heading"><h3>1. 全局选择 Provider</h3><span class="text-small text-muted">这是整次询问的总选项；所选 Provider 都必须至少承接一个任务</span></div>
      <div class="baton-providers" data-providers></div>
    </section>
    <section>
      <div class="baton-step-heading"><h3>2. 查看并勾选 exact route/profile</h3><span class="text-small text-muted">全部可选候选及不可调用项、额度来源/剩余/reset/unknown reason、评分和 callability 均在此披露</span></div>
      <div class="baton-pools" data-provider-groups></div>
      <div class="card baton-section" data-detail aria-live="polite"></div>
    </section>
    <section>
      <div class="baton-step-heading"><h3>3. 汇总分配全部任务</h3><span class="text-small text-muted" data-assignment-hint>两个路径在同一张表中，只显示已勾选且适合该任务的 route/profile</span></div>
      <div class="table-responsive"><table class="table table-sm"><thead><tr><th>路径</th><th>任务</th><th>exact route/profile</th></tr></thead><tbody data-assignments></tbody></table></div>
    </section>
    <section>
      <h3>4. 一次确认并提交</h3>
      <div class="card baton-submit-row"><div><div data-submit-state></div><div class="text-small text-muted">一次 Submit 为全部 proposal 写入同一个 confirmation ID；取消 route/provider 后相关任务会留空。</div></div><button type="button" class="btn btn-primary" data-submit>一次提交全部确认</button></div>
    </section>
  </div>
  <details class="baton-section"><summary>根据任务能力排除</summary><ul class="baton-excluded text-small" data-task-exclusions></ul></details>
  <details class="baton-section"><summary>内置禁用模型系列</summary><div class="table-responsive"><table class="table table-sm"><thead><tr><th>系列</th><th>卡片/profile 数</th><th>代码</th></tr></thead><tbody data-policy-exclusions></tbody></table></div></details>
  <div class="text-small text-muted baton-section" data-snapshot></div>
  <script>
    (() => {
      const root=document.getElementById(${safeJson(rootId)});
      const state=${safeJson(state)};
      const selectedProviders=new Set(state.default_providers);
      const checked=new Set(state.default_checked);
      const assignments={...state.default_assignments};
      const byModel=new Map(state.candidates.map((candidate)=>[candidate.model_id,candidate]));
      const byPool=new Map(state.quota_pools.map((pool)=>[pool.id,pool]));
      const providerRoot=root.querySelector("[data-providers]");
      const groups=root.querySelector("[data-provider-groups]");
      const assignmentBody=root.querySelector("[data-assignments]");
      const detail=root.querySelector("[data-detail]");
      const checkedCount=root.querySelector("[data-checked-count]");
      const providerCount=root.querySelector("[data-provider-count]");
      const submitState=root.querySelector("[data-submit-state]");
      const submitButton=root.querySelector("[data-submit]");
      const esc=(value)=>String(value??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;");
      const metric=(value)=>value==null?"—":String(value);
      const evidence=(candidate)=>candidate.reference_only?"参考数据":candidate.ranked?"精确数据":"未排名";
      const localizedStrengths=(value)=>String(value||"").replace("AA partial reference only:","AA 部分数据，仅供参考：").replace("AA-derived inference:","AA 推断：").replace("unranked; no_canonical_mapping","未排名；没有 canonical mapping").replaceAll("strong-coding","编码能力强").replaceAll("strong-agentic","Agent 能力强").replaceAll("strong-reasoning","推理能力强").replaceAll("cost-efficient","成本效率高").replaceAll("high-throughput","高吞吐").replaceAll("low-latency","低延迟").replaceAll("balanced","均衡").replaceAll("reference only","仅供参考").replaceAll("coding=","编码=").replaceAll("agentic=","Agent=").replaceAll("intelligence=","智力=").replaceAll("cost/task=","单任务成本=").replaceAll("source=","来源=");
      const aa=(candidate)=>[candidate.aa_scores.intelligence,candidate.aa_scores.coding,candidate.aa_scores.agentic].map(metric).join(" / ");
      const aaData=(candidate)=>{if(!candidate.aa_data)return"无额外 AA 数值";const groups=[];for(const [group,values] of Object.entries(candidate.aa_data)){const entries=Object.entries(values||{}).map(([key,value])=>key+"="+metric(value));if(entries.length)groups.push(group+": "+entries.join(", "))}return groups.join(" · ")||"无额外 AA 数值"};
      const preferred=(candidate)=>candidate.preferred_for.length?candidate.preferred_for.map((key)=>{const unit=state.units.find((item)=>item.key===key);return unit?unit.scope+"/"+unit.source_key:key}).join(", "):"—";
      const provenance=(candidate)=>candidate.reference_only?"原因 "+candidate.reference_reasons.join("+")+" · route "+(candidate.reference_route_id||"未知")+" · profile "+(candidate.reference_profile||"base")+" · AA "+(candidate.aa_slug||"未知"):candidate.ranked?"exact AA mapping":"unranked；无 canonical mapping";
      const aggregate=(candidate)=>{let sum=0,count=0;for(const unit of state.units){const value=candidate.scores[unit.key],max=state.task_max[unit.key];if(value!=null&&max){sum+=value/max;count+=1}}return count?sum/count*100:null};
      const poolStatus=(pool)=>pool.status==="available"?"可用":pool.status==="exhausted"?"已耗尽":"未知";
      const poolQuota=(pool)=>pool.status==="exhausted"?"额度耗尽":pool.remaining_percent==null?"未知":Number(pool.remaining_percent).toFixed(2)+"% 剩余";
      const poolDetail=(pool)=>pool.status==="unknown"?"未知原因 "+pool.reason+" · 来源 "+(pool.source||"未知"):pool.windows.map((window)=>window.label+" "+Number(window.remaining_percent).toFixed(2)+"% · reset "+(window.resets_at||"未知")).join(" · ")+" · 来源 "+(pool.source||"未知");
      const sorted=(pool)=>pool.model_ids.map((id)=>byModel.get(id)).filter(Boolean).sort((a,b)=>Number(b.automatic_eligible)-Number(a.automatic_eligible)||(aggregate(b)??-1)-(aggregate(a)??-1)||a.model_id.localeCompare(b.model_id));
      const clearProvider=(provider)=>{for(const candidate of state.candidates){if((candidate.provider||"unknown")!==provider)continue;checked.delete(candidate.model_id);for(const unit of state.units){if(assignments[unit.key]===candidate.model_id)assignments[unit.key]=""}}};
      const showDetail=(candidate)=>{const pool=byPool.get(candidate.quota_pool_id);detail.innerHTML='<div class="baton-detail-grid"><div><div class="text-muted text-small">exact route/profile</div><code>'+esc(candidate.model_id)+'</code><div><span class="viz-badge">'+esc(evidence(candidate))+'</span></div><div class="text-small">推理强度 '+esc(candidate.effective_reasoning_effort||'unknown')+' · 上下文窗口 '+esc(metric(candidate.context_window))+' tokens · fast '+esc(candidate.speed_signals.length?candidate.speed_signals.join('+'):'no')+' · 优选任务 '+esc(preferred(candidate))+'</div></div><div><div class="text-muted text-small">模型擅长项</div><div>'+esc(localizedStrengths(candidate.strengths))+'</div></div><div><div class="text-muted text-small">AA 评分</div><div>智力 / 编码 / Agent '+esc(aa(candidate))+'</div><div>单任务成本 '+esc(metric(candidate.aa_scores.cost_per_task))+' · tokens/s '+esc(metric(candidate.aa_scores.output_tokens_per_second))+' · 首答延迟 '+esc(metric(candidate.aa_scores.time_to_first_answer_seconds))+'s</div><div class="text-small">'+esc(aaData(candidate))+'</div></div><div><div class="text-muted text-small">AA / reference provenance</div><div>'+esc(provenance(candidate))+'</div></div><div><div class="text-muted text-small">quota</div><div>'+esc(pool.label+' · '+poolQuota(pool))+'</div><div class="text-small">'+esc(poolDetail(pool))+'</div></div><div><div class="text-muted text-small">汇总任务评分</div><div class="viz-stat-value">'+esc(aggregate(candidate)==null?'—':aggregate(candidate).toFixed(1))+'</div></div><div><div class="text-muted text-small">callability</div><div>'+esc(candidate.selection_code+' · '+candidate.selection_reason)+'</div></div></div>'};
      const renderProviders=()=>{providerRoot.innerHTML="";for(const provider of state.providers){const card=document.createElement("label");card.className="card baton-provider";const input=document.createElement("input");input.type="checkbox";input.className="form-check-input";input.checked=selectedProviders.has(provider.id);input.disabled=!provider.selectable;input.addEventListener("change",()=>{if(input.checked)selectedProviders.add(provider.id);else{selectedProviders.delete(provider.id);clearProvider(provider.id)}render()});const text=document.createElement("span");text.innerHTML='<strong>'+esc(provider.id)+'</strong><br><span class="text-small text-muted">'+provider.selectable_model_count+' 个可选 / '+provider.model_count+' 个已披露 route/profile'+(provider.selectable?'':' · 当前不可选')+'</span>';card.append(input,text);providerRoot.appendChild(card)}};
      const tableFor=(pool)=>{const wrap=document.createElement("div");wrap.className="table-responsive";const table=document.createElement("table");table.className="table table-sm baton-table";const scoreHeaders=state.units.map((unit)=>'<th class="text-end">'+esc(unit.scope+"/"+unit.source_key)+'</th>').join("");table.innerHTML='<thead><tr><th>使用</th><th>模型 / profile</th><th>优选任务</th><th>证据</th><th>callability</th><th class="text-end">池额度</th><th class="text-end">汇总</th>'+scoreHeaders+'<th class="text-end">AA 智/编/Agent</th></tr></thead><tbody></tbody>';const body=table.querySelector("tbody");sorted(pool).forEach((candidate,index)=>{const provider=candidate.provider||"unknown";const tr=document.createElement("tr");tr.dataset.checked=String(checked.has(candidate.model_id));const use=document.createElement("td");const control=document.createElement("div");control.className="form-check";const input=document.createElement("input");input.type="checkbox";input.className="form-check-input";input.id=${safeJson(`${rootId}-use-`)}+pool.id.replaceAll(/[^a-zA-Z0-9_-]/g,"-")+"-"+index;input.checked=checked.has(candidate.model_id);input.disabled=!candidate.selectable||!selectedProviders.has(provider);input.addEventListener("change",()=>{if(input.checked)checked.add(candidate.model_id);else{checked.delete(candidate.model_id);for(const unit of state.units){if(assignments[unit.key]===candidate.model_id)assignments[unit.key]=""}}showDetail(candidate);render()});const label=document.createElement("label");label.className="form-check-label sr-only";label.htmlFor=input.id;label.textContent="使用 "+candidate.model_id;control.append(input,label);use.appendChild(control);tr.appendChild(use);const route=document.createElement("td");const button=document.createElement("button");button.type="button";button.className="btn btn-ghost baton-route";button.title=candidate.model_id;button.setAttribute("aria-label",candidate.model_id);button.textContent=candidate.display_model_id;button.addEventListener("click",()=>showDetail(candidate));route.appendChild(button);tr.appendChild(route);const preferredCell=document.createElement("td");preferredCell.textContent=preferred(candidate);tr.appendChild(preferredCell);const evidenceCell=document.createElement("td");evidenceCell.innerHTML='<span class="viz-badge">'+esc(evidence(candidate))+'</span>';tr.appendChild(evidenceCell);const callable=document.createElement("td");callable.textContent=candidate.selection_code;tr.appendChild(callable);const quota=document.createElement("td");quota.className="text-end text-nowrap";quota.textContent=poolQuota(pool);tr.appendChild(quota);const total=document.createElement("td");total.className="text-end";total.textContent=aggregate(candidate)==null?"—":aggregate(candidate).toFixed(1);tr.appendChild(total);for(const unit of state.units){const cell=document.createElement("td");cell.className="text-end";cell.textContent=metric(candidate.scores[unit.key]);tr.appendChild(cell)}const aaCell=document.createElement("td");aaCell.className="text-end text-nowrap";aaCell.textContent=aa(candidate);tr.appendChild(aaCell);body.appendChild(tr)});wrap.appendChild(table);return wrap};
      const renderGroups=()=>{groups.innerHTML="";for(const pool of state.quota_pools){const active=selectedProviders.has(pool.provider);const block=document.createElement("details");block.className="card baton-pool"+(active?"":" baton-provider-inactive")+(pool.status==="exhausted"?" baton-pool-exhausted":"");block.open=active&&pool.model_ids.some((id)=>checked.has(id));const summary=document.createElement("summary");summary.innerHTML='<span class="baton-pool-summary"><span><strong>'+esc(pool.label)+'</strong> <span class="viz-badge">'+esc(poolStatus(pool))+'</span><span class="text-small"> · '+pool.model_ids.length+' 个候选</span></span><span class="baton-pool-quota"><strong>'+esc(poolQuota(pool))+'</strong><span class="text-small text-muted"><br>'+esc(poolDetail(pool))+'</span></span></span>';block.append(summary,tableFor(pool));groups.appendChild(block)}};
      const selectedByPool=(unit)=>state.quota_pools.map((pool)=>({pool,items:pool.model_ids.map((id)=>byModel.get(id)).filter((candidate)=>candidate&&checked.has(candidate.model_id)&&selectedProviders.has(candidate.provider||"unknown")&&unit.available_model_ids.includes(candidate.model_id))})).filter((entry)=>entry.items.length);
      const renderAssignments=()=>{assignmentBody.innerHTML="";for(const unit of state.units){const tr=document.createElement("tr");const key=document.createElement("td");key.innerHTML='<strong>'+esc(unit.scope)+'</strong><div class="text-small text-muted">'+esc(unit.source+' · '+unit.source_key)+'</div>';const task=document.createElement("td");task.innerHTML='<div>'+esc(unit.description)+'</div><div class="text-small text-muted">优选 '+esc(unit.recommended_model_id||'需手动选择')+' · '+esc(unit.recommendation_reason)+' · 目标强度 '+esc(unit.target_reasoning_effort)+' ('+esc(unit.complexity_reason)+') · 上下文需求 '+esc(unit.estimated_context_tokens)+' ('+esc(unit.context_estimate_reason)+')</div>';const choice=document.createElement("td");const select=document.createElement("select");select.className="form-select";select.setAttribute("aria-label",unit.key+" exact route/profile");const empty=document.createElement("option");empty.value="";empty.textContent="请选择 exact route/profile";select.appendChild(empty);for(const entry of selectedByPool(unit)){const group=document.createElement("optgroup");group.label=entry.pool.label+" · "+poolQuota(entry.pool);for(const candidate of entry.items.slice().sort((a,b)=>a.model_id.localeCompare(b.model_id))){const option=document.createElement("option");option.value=candidate.model_id;option.title=candidate.model_id;option.textContent=candidate.display_model_id+(candidate.model_id===unit.recommended_model_id?' · 优选':'');group.appendChild(option)}select.appendChild(group)}select.value=assignments[unit.key]||"";if(!unit.available_model_ids.includes(select.value))select.value="";select.addEventListener("change",()=>{assignments[unit.key]=select.value;updateSubmit()});choice.appendChild(select);tr.append(key,task,choice);assignmentBody.appendChild(tr)}};
      const updateSubmit=()=>{const validUnits=state.units.filter((unit)=>{const candidate=byModel.get(assignments[unit.key]);return candidate&&checked.has(candidate.model_id)&&selectedProviders.has(candidate.provider||"unknown")&&unit.available_model_ids.includes(candidate.model_id)});const usedProviders=new Set(validUnits.map((unit)=>byModel.get(assignments[unit.key]).provider||"unknown"));const unused=[...selectedProviders].filter((provider)=>!usedProviders.has(provider));const complete=validUnits.length;const ready=selectedProviders.size>0&&complete===state.units.length&&unused.length===0;checkedCount.textContent=String(checked.size);providerCount.textContent=selectedProviders.size+" / "+state.providers.filter((provider)=>provider.selectable).length;submitButton.disabled=!ready;let message="已分配 "+complete+" / "+state.units.length+" 个任务";if(!selectedProviders.size)message+=" · 请先选择全局 Provider";else if(unused.length)message+=" · 尚未使用 Provider: "+unused.join(", ");else message+=ready?" · 可以一次提交":" · 仍需选择 exact route";submitState.textContent=message;submitState.className=ready?"":"text-destructive"};
      const shellQuote=(value)=>"'"+String(value).replaceAll("'","'\\\"'\\\"'")+"'";
      const commandFor=(target,globalProviders)=>{const entries=target.units.map((unit)=>({key:unit.source_key,model:assignments[unit.view_key]}));const localProviders=[...new Set(entries.map((entry)=>byModel.get(entry.model).provider||"unknown"))].sort();let command="baton selection approve "+shellQuote(target.proposal_id)+" --confirm --confirmation-id "+shellQuote(state.confirmation_id)+" --confirmation-scope "+shellQuote(state.confirmation_scope);for(const provider of localProviders)command+=" --provider "+shellQuote(provider);for(const provider of globalProviders)command+=" --global-provider "+shellQuote(provider);for(const entry of entries)command+=" --route "+shellQuote(entry.key+"="+entry.model);command+=" --json";return target.cwd?"cd "+shellQuote(target.cwd)+" && "+command:command};
      const render=()=>{renderProviders();renderGroups();renderAssignments();updateSubmit()};
      submitButton.addEventListener("click",async()=>{updateSubmit();if(submitButton.disabled)return;const globalProviders=[...selectedProviders].sort();const assignmentsText=state.units.map((unit)=>unit.scope+"/"+unit.source_key+" = "+assignments[unit.key]).join("\\n");const commands=state.approval_targets.map((target)=>"["+target.scope+"]\\n"+commandFor(target,globalProviders)).join("\\n\\n");const prompt="我已在 Baton 汇总选择界面点击“一次提交全部确认”。这是对全部路径的一次显式模型确认。\\nconfirmation_id: "+state.confirmation_id+"\\n全局 Provider: "+globalProviders.join(", ")+"\\n禁止 silent fallback；任何 exact route/profile 不可调用时必须停下报告。\\n\\n任务分配：\\n"+assignmentsText+"\\n\\n请在当前窗口按以下命令处理全部 proposal，并保持同一个 confirmation_id：\\n"+commands;submitButton.disabled=true;submitState.textContent="正在一次提交全部模型确认…";try{if(!window.openai||typeof window.openai.sendFollowUpMessage!=="function")throw new Error("CURRENT_WINDOW_SUBMIT_UNAVAILABLE");await window.openai.sendFollowUpMessage({prompt,title:"一次确认全部 Baton 模型选择"});submitState.textContent="已一次提交，等待 Baton host 处理全部路径";submitState.className=""}catch(error){submitButton.disabled=false;submitState.textContent="当前窗口无法提交 · "+(error instanceof Error?error.message:String(error));submitState.className="text-destructive"}});
      root.querySelector("[data-model-count]").textContent=String(state.candidates.filter((candidate)=>candidate.selectable).length);
      if(state.has_suggestions)root.querySelector("[data-assignment-hint]").textContent="已按汇总建议预选 Provider、route/profile 和任务分配；可一次修改后统一提交";
      const taskExclusions=root.querySelector("[data-task-exclusions]");for(const item of state.task_exclusions){const li=document.createElement("li");li.innerHTML='<code>'+esc(item.model_id)+'</code> · '+esc(item.code);taskExclusions.appendChild(li)}
      const policyBody=root.querySelector("[data-policy-exclusions]");for(const item of state.policy_exclusions){const tr=document.createElement("tr");for(const value of [item.family,String(item.card_count),item.code]){const td=document.createElement("td");td.textContent=value;tr.appendChild(td)}policyBody.appendChild(tr)}
      root.querySelector("[data-snapshot]").textContent="OpenCodex catalog "+state.catalog_fingerprint+" · confirmation "+state.confirmation_id;
      const first=state.candidates.find((candidate)=>checked.has(candidate.model_id))||state.candidates.find((candidate)=>candidate.selectable);if(first)showDetail(first);else detail.textContent="没有可选择的 exact route/profile。";
      render();
    })();
  </script>
</div>`;
}

export function renderSelectionBundle(inputs: SelectionBundleInput[]): string {
  const bundle = bundleProposal(inputs);
  return renderSelectionView(bundle.proposal, bundle.options);
}

export function selectionViewArtifact(outputPath: string): SelectionViewArtifact {
  const file = path.resolve(outputPath);
  return {
    output: file,
    presentation: SELECTION_PRESENTATION,
    surface: "current_conversation",
    display_language: "zh-CN",
    inline_content_reference: `visualize${JSON.stringify({ path: file })}`,
    content_reference: { kind: SELECTION_INLINE_REFERENCE_KIND, path: file },
    host_action: "emit_inline_content_reference_in_current_response",
    browser_navigation_allowed: false,
    file_link_allowed: false,
  };
}

function writeView(outputPath: string, content: string): SelectionViewArtifact {
  const artifact = selectionViewArtifact(outputPath);
  fs.mkdirSync(path.dirname(artifact.output), { recursive: true });
  const temp = `${artifact.output}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(temp, content, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temp, artifact.output);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
  return artifact;
}

export function writeSelectionView(proposal: SelectionProposal, outputPath: string, options: SelectionViewOptions = {}): SelectionViewArtifact {
  return writeView(outputPath, renderSelectionView(proposal, options));
}

export function writeSelectionBundle(inputs: SelectionBundleInput[], outputPath: string): SelectionViewArtifact {
  return writeView(outputPath, renderSelectionBundle(inputs));
}
