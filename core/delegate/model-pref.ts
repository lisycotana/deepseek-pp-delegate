/**
 * Per-task model mode preselection.
 *
 * DeepSeek's web model mode is fixed when a conversation is created — it cannot
 * switch mid-conversation. A delegate runs each task in its own fresh
 * conversation, so it can pick the mode per task from the task text. This keeps
 * the user from having to choose a mode up front: the delegate picks vision for
 * image tasks, expert for reasoning, default otherwise, and enables web search
 * when the task asks for current information.
 *
 * The rules are keyword-based rather than model-driven: a prompt is short, the
 * decision must be instant, and a wrong guess costs only a default-mode turn.
 *
 * @module core/delegate/model-pref
 */

/** A mode preference resolved from a task prompt. */
export interface ModelPreference {
  /** 'default' | 'expert' | 'vision', or null to keep the loop default. */
  readonly modelType: 'default' | 'expert' | 'vision' | null;
  /** Whether to enable DeepSeek's web search for this task. */
  readonly searchEnabled: boolean;
}

// Image keywords: the task needs multimodal input. Vision mode is required for
// image understanding; the prompt usually names an image file or a screenshot.
const VISION_PATTERNS = [
  /图片/, /截图/, /看图/, /识图/, /识别图/, /图表/, /照片/, /image/i, /screenshot/i, /photo/i,
  /read_image/, /\.png/i, /\.jpe?g/i, /\.webp/i, /\.gif/i,
];

// Reasoning keywords: the task benefits from deep thinking. Expert mode runs
// DeepSeek-Reasoner, which is slower but reasons more carefully.
const EXPERT_PATTERNS = [
  /分析/, /推理/, /思考/, /为什么/, /原因/, /原理/, /根因/, /调试/, /debug/i, /investigate/i,
  /why\b/i, /reason/i, /root cause/i, /diagnos/i, /analyz/i,
];

// Web-search keywords: the task needs current information that the model does
// not know. Search is an independent toggle, not a mode.
const SEARCH_PATTERNS = [
  /最新/, /当前/, /实时/, /新闻/, /价格/, /搜索/, /查询/, /今天的/, /目前的/,
  /latest/i, /current\b/i, /today/i, /now\b/i, /news/i, /price/i, /recent/i,
];

/**
 * Infer the model mode and search toggle from a task prompt.
 *
 * Returns `modelType: null` when no pattern matches, so the caller's configured
 * default applies — a user who always wants expert can still set it globally and
 * let per-task detection stay silent.
 * @param prompt - the task text the delegate will run.
 * @returns the resolved preference.
 */
export function prefelModelType(prompt: string): ModelPreference {
  const text = prompt.toLowerCase();

  const wantsVision = VISION_PATTERNS.some((pattern) => pattern.test(text) || pattern.test(prompt));
  const wantsExpert = EXPERT_PATTERNS.some((pattern) => pattern.test(text) || pattern.test(prompt));
  const wantsSearch = SEARCH_PATTERNS.some((pattern) => pattern.test(text) || pattern.test(prompt));

  // Vision wins over expert: an image task needs the vision model specifically;
  // expert cannot read images. A prompt that names both image and reasoning
  // still needs vision first.
  const modelType = wantsVision ? 'vision' : wantsExpert ? 'expert' : null;

  return { modelType, searchEnabled: wantsSearch };
}
