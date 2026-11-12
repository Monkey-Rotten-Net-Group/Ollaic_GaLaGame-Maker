# MiniMax image generation

MiniMax is available in **AI Settings → Image → MiniMax 图片**. The native media gateway calls `POST /v1/image_generation`; no CLI or MCP installation is required. Existing background, CG, and character-generation flows use the same adapter.

## Configure the provider

1. Select **MiniMax 图片** in the Image tab.
2. Select `image-01`. The catalog also offers `image-01-live`, documented by MiniMax's China platform; availability depends on your region and account.
3. Enter your Token Plan **Subscription Key** in API Key. MiniMax also accepts pay-as-you-go keys, but they use separate billing resources. Ollaic forwards the key you supply and does not switch billing modes automatically.
4. Set Base URL to match the platform where you purchased the subscription:

   | Subscription region | Base URL |
   | --- | --- |
   | International | `https://api.minimax.io/v1` (default when empty) |
   | Mainland China | `https://api.minimax.cn/v1` |

5. Click **保存**, then generate an image through the existing asset or character controls.

The adapter appends `/image_generation` to this base URL. A full URL already ending in `/image_generation` is also accepted. Do not use OpenAI's `/images/generations` path for MiniMax.

The key stays in the native provider configuration. This change does not migrate saved settings or reuse the Video key automatically. Never paste keys into source code or diagnostics.

## Request and result behavior

The adapter sends the selected model, prompt, aspect ratio, `n: 1`, and `response_format: "base64"`. It requests image bytes directly so generated assets do not depend on a provider URL that expires after 24 hours. The existing save flow receives the standard `GeneratedMedia` result, with the file extension detected from the returned PNG, JPEG, or WebP bytes. Before returning success, a blocking worker decodes the image with a 64 MiB allocation limit and a 4,096-pixel limit per dimension; truncated or excessive images fail before asset persistence.

MiniMax accepts prompts of at most 1,500 characters. Longer prompts fail locally without truncation. Supported aspect ratios are `1:1`, `16:9`, `4:3`, `3:2`, `2:3`, `3:4`, `9:16`, and `21:9`; when omitted, the adapter uses `1:1`.

Character references use `subject_reference: [{ "type": "character", "image_file": "data:..." }]`. MiniMax documents this as **human-character subject reference**, not arbitrary scene editing. Use a clear, single-person reference. The adapter accepts a single nonempty JPEG or PNG reference smaller than 10 MB and keeps the reference when generating expression variants. This does not guarantee identity consistency for stylized or nonhuman characters.

HTTP success alone does not mean generation succeeded: the adapter checks `base_resp.status_code`. Authentication failures, exhausted resources, rate limits, invalid parameters, moderation/no-image results, malformed JSON, invalid base64, and unsupported image formats return errors. Successful results and business failures use the existing redacted provider log; full base64 responses are not logged by the adapter.

## Verification boundary

Automated tests use generated image fixtures and a loopback HTTP server. They check the native request path, bearer authentication, region selection, character references, image formats, and failure parsing without calling MiniMax. An actual account request is still needed to confirm your key's region, plan coverage, and available quota.

## Sources

- [MiniMax China text-to-image API](https://platform.minimax.cn/docs/api-reference/image-generation-t2i)
- [MiniMax international text-to-image API](https://platform.minimax.io/docs/api-reference/image-generation-t2i)
- [MiniMax image-to-image API](https://platform.minimax.io/docs/api-reference/image-generation-i2i)
- [Token Plan overview](https://platform.minimax.io/docs/token-plan/intro)
- [Provider configuration](./providers.md)
- [Media gateway](./gateway.md)
