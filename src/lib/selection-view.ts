import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { SelectionCandidate, SelectionProposal } from "./selection.js";

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
}

export interface SelectionViewOptions {
  taskLabels?: Record<string, string>;
}

function safeJson(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

function viewState(proposal: SelectionProposal, options: SelectionViewOptions = {}) {
  const visibleModels = new Set(proposal.quota_pools.flatMap((pool) => pool.model_ids));
  const units = proposal.units.filter((unit) => !unit.director_local).map((unit) => ({
    key: unit.key,
    description: options.taskLabels?.[unit.key] || unit.description,
    recommended_model_id: unit.recommended_model_id,
    default_model_id: unit.default_model_id && visibleModels.has(unit.default_model_id) ? unit.default_model_id : null,
  }));
  const candidates = new Map<string, ViewCandidate>();
  for (const unit of proposal.units) {
    if (unit.director_local) continue;
    for (const candidate of unit.candidates) {
      if (!visibleModels.has(candidate.model_id)) continue;
      const existing = candidates.get(candidate.model_id);
      if (!existing) {
        candidates.set(candidate.model_id, {
          ...structuredClone(candidate),
          scores: { [unit.key]: candidate.task_score },
          preferred_for: candidate.model_id === unit.recommended_model_id ? [unit.key] : [],
        });
        continue;
      }
      existing.scores[unit.key] = candidate.task_score;
      if (candidate.model_id === unit.recommended_model_id) existing.preferred_for.push(unit.key);
    }
  }
  const taskMax = Object.fromEntries(units.map((unit) => {
    const values = [...candidates.values()].map((candidate) => candidate.scores[unit.key]).filter((value): value is number => typeof value === "number");
    return [unit.key, values.length ? Math.max(...values) : null];
  }));
  return {
    proposal_id: proposal.id,
    source: proposal.source,
    host_snapshot_id: proposal.host_snapshot_id,
    catalog_fingerprint: proposal.catalog_fingerprint,
    units,
    task_max: taskMax,
    candidates: [...candidates.values()],
    quota_pools: proposal.quota_pools,
    task_exclusions: proposal.task_exclusions,
    policy_exclusions: proposal.policy_exclusions,
    default_checked: [...new Set(units.map((unit) => unit.default_model_id).filter((value): value is string => Boolean(value)))],
    default_assignments: Object.fromEntries(units.map((unit) => [unit.key, unit.default_model_id || ""])),
  };
}

export function renderSelectionView(proposal: SelectionProposal, options: SelectionViewOptions = {}): string {
  const state = viewState(proposal, options);
  const rootId = `baton-selection-${proposal.id.replaceAll(/[^a-zA-Z0-9_-]/g, "-")}`;
  return `<div id="${rootId}" data-baton-presentation="${SELECTION_PRESENTATION}">
  <style>
    #${rootId} .baton-heading,#${rootId} .baton-step-heading,#${rootId} .baton-pool-summary,#${rootId} .baton-submit-row{display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap}
    #${rootId} .baton-flow,#${rootId} .baton-pools{display:grid;gap:18px}
    #${rootId} .baton-pools{gap:12px}
    #${rootId} .baton-section{margin-top:20px}
    #${rootId} .baton-pool{margin:0}
    #${rootId} .baton-pool>summary{cursor:pointer}
    #${rootId} .baton-pool-quota{text-align:right}
    #${rootId} .baton-pool-exhausted{opacity:.48;filter:saturate(0)}
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
    <h2>Baton 模型选择</h2>
    <span class="text-small text-muted">确认提交前 0 ticket · 0 subagent</span>
  </div>
  <div class="viz-grid">
    <div class="card viz-stat"><div class="text-muted">额度池</div><div class="viz-stat-value" data-pool-count></div><div class="text-small">Cursor API / Auto 独立计算</div></div>
    <div class="card viz-stat"><div class="text-muted">适合当前任务的模型</div><div class="viz-stat-value" data-model-count></div><div class="text-small">当前 host ∩ OpenCodex catalog ∩ 任务能力</div></div>
    <div class="card viz-stat"><div class="text-muted">已勾选的精确 route</div><div class="viz-stat-value" data-checked-count></div><div class="text-small">可增减；不会自动 fallback</div></div>
  </div>
  <div class="baton-flow baton-section">
    <section>
      <div class="baton-step-heading"><h3>1. 从 Provider 额度池中选择模型</h3><span class="text-small text-muted">可用额度降序 · 未知其次 · 已耗尽最后</span></div>
      <div class="baton-pools" data-provider-groups></div>
      <div class="card baton-section" data-detail aria-live="polite"></div>
    </section>
    <section>
      <div class="baton-step-heading"><h3>2. 为任务分配已勾选模型</h3><span class="text-small text-muted">只显示已勾选的精确 route/profile</span></div>
      <div class="table-responsive"><table class="table table-sm"><thead><tr><th>单元</th><th>任务</th><th>精确 route/profile</th></tr></thead><tbody data-assignments></tbody></table></div>
    </section>
    <section>
      <h3>3. 确认并提交</h3>
      <div class="card baton-submit-row"><div><div data-submit-state></div><div class="text-small text-muted">取消已分配 route 后，对应任务会留空；“确认提交”自动禁用。</div></div><button type="button" class="btn btn-primary" data-submit>确认提交</button></div>
    </section>
  </div>
  <details class="baton-section"><summary>根据任务能力排除</summary><ul class="baton-excluded text-small" data-task-exclusions></ul></details>
  <details class="baton-section"><summary>内置禁用模型系列</summary><div class="table-responsive"><table class="table table-sm"><thead><tr><th>系列</th><th>卡片/profile 数</th><th>代码</th></tr></thead><tbody data-policy-exclusions></tbody></table></div></details>
  <div class="text-small text-muted baton-section" data-snapshot></div>
  <script>
    (() => {
      const root=document.getElementById(${safeJson(rootId)});
      const state=${safeJson(state)};
      const checked=new Set(state.default_checked);
      const assignments={...state.default_assignments};
      const byModel=new Map(state.candidates.map((candidate)=>[candidate.model_id,candidate]));
      const byPool=new Map(state.quota_pools.map((pool)=>[pool.id,pool]));
      const groups=root.querySelector("[data-provider-groups]");
      const assignmentBody=root.querySelector("[data-assignments]");
      const detail=root.querySelector("[data-detail]");
      const checkedCount=root.querySelector("[data-checked-count]");
      const submitState=root.querySelector("[data-submit-state]");
      const submitButton=root.querySelector("[data-submit]");
      const esc=(value)=>String(value??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;");
      const metric=(value)=>value==null?"—":String(value);
      const evidence=(candidate)=>candidate.reference_only?"参考数据":candidate.ranked?"精确数据":"未排名";
      const localizedStrengths=(value)=>String(value||"").replace("AA partial reference only:","AA 部分数据，仅供参考：").replace("AA-derived inference:","AA 推断：").replace("unranked; no_canonical_mapping","未排名；没有 canonical mapping").replaceAll("strong-coding","编码能力强").replaceAll("strong-agentic","Agent 能力强").replaceAll("strong-reasoning","推理能力强").replaceAll("cost-efficient","成本效率高").replaceAll("high-throughput","高吞吐").replaceAll("low-latency","低延迟").replaceAll("balanced","均衡").replaceAll("reference only","仅供参考").replaceAll("coding=","编码=").replaceAll("agentic=","Agent=").replaceAll("intelligence=","智力=").replaceAll("cost/task=","单任务成本=").replaceAll("source=","来源=");
      const aa=(candidate)=>[candidate.aa_scores.intelligence,candidate.aa_scores.coding,candidate.aa_scores.agentic].map(metric).join(" / ");
      const aggregate=(candidate)=>{let sum=0,count=0;for(const unit of state.units){const value=candidate.scores[unit.key],max=state.task_max[unit.key];if(value!=null&&max){sum+=value/max;count+=1}}return count?sum/count*100:null};
      const poolStatus=(pool)=>pool.status==="available"?"可用":pool.status==="exhausted"?"已耗尽":"未知";
      const poolQuota=(pool)=>pool.status==="exhausted"?"额度耗尽":pool.remaining_percent==null?"未知":Number(pool.remaining_percent).toFixed(2)+"% 剩余";
      const poolDetail=(pool)=>pool.status==="unknown"?"未知原因 "+pool.reason+" · 来源 "+(pool.source||"未知"):pool.windows.map((window)=>window.label+" "+Number(window.remaining_percent).toFixed(2)+"% · 重置 "+(window.resets_at||"未知")).join(" · ")+" · 来源 "+(pool.source||"未知");
      const sorted=(pool)=>pool.model_ids.map((id)=>byModel.get(id)).filter(Boolean).sort((a,b)=>Number(b.automatic_eligible)-Number(a.automatic_eligible)||(aggregate(b)??-1)-(aggregate(a)??-1)||a.model_id.localeCompare(b.model_id));
      const hostReason=(candidate)=>candidate.host.reason==="route is executable in OpenCodex and advertised by the current Codex host"?"OpenCodex 可执行，且当前 Codex host 已声明":candidate.host.reason;
      const showDetail=(candidate)=>{const pool=byPool.get(candidate.quota_pool_id);detail.innerHTML='<div class="baton-detail-grid"><div><div class="text-muted text-small">精确 route/profile</div><code>'+esc(candidate.model_id)+'</code><div><span class="viz-badge">'+esc(evidence(candidate))+'</span> '+esc(candidate.host.code)+'</div></div><div><div class="text-muted text-small">模型擅长项</div><div>'+esc(localizedStrengths(candidate.strengths))+'</div></div><div><div class="text-muted text-small">AA 证据</div><div>智力 / 编码 / Agent '+esc(aa(candidate))+'</div><div>单任务成本 '+esc(metric(candidate.aa_scores.cost_per_task))+' · tokens/s '+esc(metric(candidate.aa_scores.output_tokens_per_second))+' · 首答延迟 '+esc(metric(candidate.aa_scores.time_to_first_answer_seconds))+'s</div></div><div><div class="text-muted text-small">额度池</div><div>'+esc(pool.label+' · '+poolQuota(pool))+'</div><div class="text-small">'+esc(poolDetail(pool))+'</div></div><div><div class="text-muted text-small">综合任务评分</div><div class="viz-stat-value">'+esc(aggregate(candidate)==null?'—':aggregate(candidate).toFixed(1))+'</div></div><div><div class="text-muted text-small">可调用性</div><div>'+esc(candidate.host.code+' · '+hostReason(candidate))+'</div></div></div>'};
      const tableFor=(pool)=>{const wrap=document.createElement("div");wrap.className="table-responsive";const table=document.createElement("table");table.className="table table-sm baton-table";const scoreHeaders=state.units.map((unit)=>'<th class="text-end">'+esc(unit.key)+'</th>').join("");table.innerHTML='<thead><tr><th>使用</th><th>精确 route/profile</th><th>证据</th><th class="text-end">池额度</th><th class="text-end">综合</th>'+scoreHeaders+'<th class="text-end">AA 智/编/Agent</th></tr></thead><tbody></tbody>';const body=table.querySelector("tbody");sorted(pool).forEach((candidate,index)=>{const tr=document.createElement("tr");tr.dataset.checked=String(checked.has(candidate.model_id));const use=document.createElement("td");const control=document.createElement("div");control.className="form-check";const input=document.createElement("input");input.type="checkbox";input.className="form-check-input";input.id=${safeJson(rootId+"-use-")}+pool.id.replaceAll(/[^a-zA-Z0-9_-]/g,"-")+"-"+index;input.checked=checked.has(candidate.model_id);input.disabled=!candidate.selectable;input.addEventListener("change",()=>{if(input.checked)checked.add(candidate.model_id);else{checked.delete(candidate.model_id);for(const unit of state.units){if(assignments[unit.key]===candidate.model_id)assignments[unit.key]=""}}showDetail(candidate);render()});const label=document.createElement("label");label.className="form-check-label sr-only";label.htmlFor=input.id;label.textContent="使用 "+candidate.model_id;control.append(input,label);use.appendChild(control);tr.appendChild(use);const route=document.createElement("td");const button=document.createElement("button");button.type="button";button.className="btn btn-ghost baton-route";button.textContent=candidate.model_id;button.addEventListener("click",()=>showDetail(candidate));route.appendChild(button);tr.appendChild(route);const evidenceCell=document.createElement("td");evidenceCell.innerHTML='<span class="viz-badge">'+esc(evidence(candidate))+'</span>';tr.appendChild(evidenceCell);const quota=document.createElement("td");quota.className="text-end text-nowrap";quota.textContent=poolQuota(pool);tr.appendChild(quota);const total=document.createElement("td");total.className="text-end";total.textContent=aggregate(candidate)==null?"—":aggregate(candidate).toFixed(1);tr.appendChild(total);for(const unit of state.units){const cell=document.createElement("td");cell.className="text-end";cell.textContent=metric(candidate.scores[unit.key]);tr.appendChild(cell)}const aaCell=document.createElement("td");aaCell.className="text-end text-nowrap";aaCell.textContent=aa(candidate);tr.appendChild(aaCell);body.appendChild(tr)});wrap.appendChild(table);return wrap};
      const renderGroups=()=>{groups.innerHTML="";for(const pool of state.quota_pools){if(pool.status==="exhausted"){const disabled=document.createElement("div");disabled.className="card baton-pool baton-pool-exhausted";disabled.innerHTML='<div class="baton-pool-summary"><div><strong>'+esc(pool.label)+'</strong><div class="text-small">已隐藏 '+pool.model_ids.length+' 个精确 route/profile</div></div><div class="baton-pool-quota text-destructive">额度耗尽</div></div>';groups.appendChild(disabled);continue}const block=document.createElement("details");block.className="card baton-pool";block.open=pool.model_ids.some((id)=>checked.has(id));const summary=document.createElement("summary");summary.innerHTML='<span class="baton-pool-summary"><span><strong>'+esc(pool.label)+'</strong> <span class="viz-badge">'+esc(poolStatus(pool))+'</span><span class="text-small"> · '+pool.model_ids.length+' 个模型</span></span><span class="baton-pool-quota"><strong>'+esc(poolQuota(pool))+'</strong><span class="text-small text-muted"><br>'+esc(poolDetail(pool))+'</span></span></span>';block.append(summary,tableFor(pool));groups.appendChild(block)}};
      const selectedByPool=()=>state.quota_pools.map((pool)=>({pool,items:pool.model_ids.map((id)=>byModel.get(id)).filter((candidate)=>candidate&&checked.has(candidate.model_id))})).filter((entry)=>entry.items.length);
      const renderAssignments=()=>{assignmentBody.innerHTML="";for(const unit of state.units){const tr=document.createElement("tr");const key=document.createElement("td");key.innerHTML='<strong>'+esc(unit.key)+'</strong><div class="text-small text-muted">'+esc(state.source)+'</div>';const task=document.createElement("td");task.textContent=unit.description;const choice=document.createElement("td");const select=document.createElement("select");select.className="form-select";select.setAttribute("aria-label",unit.key+" exact route/profile");const empty=document.createElement("option");empty.value="";empty.textContent="请选择 exact route/profile";select.appendChild(empty);for(const entry of selectedByPool()){const group=document.createElement("optgroup");group.label=entry.pool.label+" · "+poolQuota(entry.pool);for(const candidate of entry.items.sort((a,b)=>a.model_id.localeCompare(b.model_id))){const option=document.createElement("option");option.value=candidate.model_id;option.textContent=candidate.model_id;group.appendChild(option)}select.appendChild(group)}select.value=assignments[unit.key]||"";select.addEventListener("change",()=>{assignments[unit.key]=select.value;updateSubmit()});choice.appendChild(select);tr.append(key,task,choice);assignmentBody.appendChild(tr)}};
      const updateSubmit=()=>{const complete=state.units.filter((unit)=>checked.has(assignments[unit.key])).length;checkedCount.textContent=String(checked.size);submitButton.disabled=complete!==state.units.length;submitState.textContent="已分配 "+complete+" / "+state.units.length+" 个任务 · "+(complete===state.units.length?"可以提交":"需要选择精确 route");submitState.className=complete===state.units.length?"":"text-destructive"};
      const render=()=>{renderGroups();renderAssignments();updateSubmit()};
      submitButton.addEventListener("click",async()=>{updateSubmit();if(submitButton.disabled)return;const lines=state.units.map((unit)=>unit.key+"="+assignments[unit.key]);const args=state.source==="standalone"?" --model "+assignments[state.units[0].key]:lines.map((line)=>" --route "+line).join("");const prompt="我已在 Baton proposal "+state.proposal_id+" 的模型选择界面点击“确认提交”。这是显式模型确认。\\n请严格执行以下精确 route/profile approval；禁止 silent fallback：\\n"+lines.join("\\n")+"\\n命令：baton selection approve "+state.proposal_id+" --confirm"+args;submitButton.disabled=true;submitState.textContent="正在提交精确 route/profile 确认…";try{if(!window.openai||typeof window.openai.sendFollowUpMessage!=="function")throw new Error("CURRENT_WINDOW_SUBMIT_UNAVAILABLE");await window.openai.sendFollowUpMessage({prompt,title:"确认 Baton 模型选择"});submitState.textContent="已提交，等待 Baton host 处理"}catch(error){submitButton.disabled=false;submitState.textContent="当前窗口无法提交 · "+(error instanceof Error?error.message:String(error));submitState.className="text-destructive"}});
      root.querySelector("[data-pool-count]").textContent=String(state.quota_pools.length);
      root.querySelector("[data-model-count]").textContent=String(state.candidates.length);
      const taskExclusions=root.querySelector("[data-task-exclusions]");for(const item of state.task_exclusions){const li=document.createElement("li");li.innerHTML='<code>'+esc(item.model_id)+'</code> · '+esc(item.code);taskExclusions.appendChild(li)}
      const policyBody=root.querySelector("[data-policy-exclusions]");for(const item of state.policy_exclusions){const tr=document.createElement("tr");for(const value of [item.family,String(item.card_count),item.code]){const td=document.createElement("td");td.textContent=value;tr.appendChild(td)}policyBody.appendChild(tr)}
      root.querySelector("[data-snapshot]").textContent="Host snapshot "+state.host_snapshot_id+" · catalog "+state.catalog_fingerprint+" · 额度耗尽的池已隐藏模型且不可选择。";
      const first=state.candidates.find((candidate)=>checked.has(candidate.model_id))||state.candidates.find((candidate)=>candidate.selectable);if(first)showDetail(first);else detail.textContent="没有可选择的精确 route/profile。";
      render();
    })();
  </script>
</div>`;
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

export function writeSelectionView(proposal: SelectionProposal, outputPath: string, options: SelectionViewOptions = {}): SelectionViewArtifact {
  const artifact = selectionViewArtifact(outputPath);
  const file = artifact.output;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(temp, renderSelectionView(proposal, options), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
  return artifact;
}
