import Anthropic from '@anthropic-ai/sdk';

export type ChatMessage = Anthropic.Beta.BetaMessageParam;

export interface StreamHandlers {
  onText: (delta: string) => void;
  signal?: AbortSignal;
}

export class AssistantError extends Error {}

/**
 * Stream one assistant turn. The request goes directly from the browser to
 * the Anthropic API with the user's own key. The full assistant content is
 * returned so the conversation can be appended to unchanged.
 */
export async function streamReply(opts: { apiKey: string; model: string; system: string; messages: ChatMessage[] } & StreamHandlers): Promise<Anthropic.Beta.BetaMessage> {
  const client = new Anthropic({ apiKey: opts.apiKey, dangerouslyAllowBrowser: true, maxRetries: 1 });
  try {
    const stream = client.beta.messages.stream(
      {
        model: opts.model,
        max_tokens: 64000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'medium' },
        system: [{ type: 'text', text: opts.system, cache_control: { type: 'ephemeral' } }],
        messages: opts.messages,
      },
      { signal: opts.signal },
    );
    stream.on('text', (t) => opts.onText(t));
    const final = await stream.finalMessage();
    if (final.stop_reason === 'refusal') {
      throw new AssistantError('The model declined to answer this request.');
    }
    return final;
  } catch (err) {
    if (err instanceof AssistantError) throw err;
    if (err instanceof Anthropic.AuthenticationError) throw new AssistantError('The API key was rejected. Check it in Settings.');
    if (err instanceof Anthropic.PermissionDeniedError) throw new AssistantError('This API key does not have access to the selected model.');
    if (err instanceof Anthropic.NotFoundError) throw new AssistantError('The selected model was not found. Choose another model in Settings.');
    if (err instanceof Anthropic.RateLimitError) throw new AssistantError('Rate limited by the API — wait a moment and try again.');
    if (err instanceof Anthropic.BadRequestError) throw new AssistantError(`The request was rejected: ${err.message}`);
    if (err instanceof Anthropic.APIUserAbortError) throw new AssistantError('Stopped.');
    if (err instanceof Anthropic.APIConnectionError) throw new AssistantError('Could not reach the Anthropic API. Check your connection (or whether a browser extension blocks the request).');
    if (err instanceof Anthropic.APIError) throw new AssistantError(`API error ${err.status ?? ''}: ${err.message}`);
    throw new AssistantError(err instanceof Error ? err.message : String(err));
  }
}
