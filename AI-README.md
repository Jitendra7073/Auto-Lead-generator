# 🤖 AI Multi-Provider System

## Overview

This system provides **10 AI provider integrations** with automatic fallback, health monitoring, and cost tracking. It ensures reliable AI processing even when some providers are down or rate-limited.

## Supported Providers

| Provider | Model | Free Tier | Priority | Cost (per 1M tokens) |
|----------|-------|-----------|----------|---------------------|
| **Groq** | Llama 3.3 70B | 10K requests/day | 1 | Free |
| **Gemini** | 2.0 Flash | 15 requests/min | 2 | $0.075 / $0.30 |
| **Anthropic** | Claude 3.5 Haiku | No | 3 | $0.80 / $1.00 |
| **Cohere** | Command R | Free trial | 4 | $0.50 / $1.50 |
| **Mistral** | Mistral Small | Free tier | 5 | $2.00 / $6.00 |
| **DeepSeek** | DeepSeek Chat | Very affordable | 6 | $0.14 / $0.28 |
| **Hugging Face** | Qwen 2.5 72B | Free | 7 | Free |
| **Together** | Llama 3.3 70B | $25 free credits | 8 | $0.89 / $0.89 |
| **Perplexity** | Sonar Small | Free tier | 9 | $0.20 / $0.20 |
| **OpenAI** | GPT-4o Mini | No | 10 | $0.15 / $0.60 |

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure API Keys

Copy `.env.example` to `.env` and add at least one API key:

```bash
cp .env.example .env
```

#### Minimum Configuration (Recommended: Groq + Gemini)

```env
# Groq (Free, Fastest) - Get key from: https://console.groq.com/
GROQ_API_KEY=gsk_your_key_here

# Gemini (Free) - Get key from: https://ai.google.dev/
GEMINI_API_KEY=AIzaSy_your_key_here
```

#### All Providers (Optional)

```env
# Add any of these for more fallback options:
ANTHROPIC_API_KEY=sk-ant-your_key_here
COHERE_API_KEY=your_key_here
MISTRAL_API_KEY=your_key_here
DEEPSEEK_API_KEY=sk-your_key_here
HUGGINGFACE_API_KEY=hf_your_key_here
TOGETHER_API_KEY=your_key_here
PERPLEXITY_API_KEY=pplx-your_key_here
OPENAI_API_KEY=sk-proj-your_key_here
```

## How to Get API Keys

### Free Tier Providers (Start Here)

1. **Groq** (Recommended - Fastest & Free)
   - Go to: https://console.groq.com/
   - Sign up for free
   - Create API key
   - 10,000 requests/day free

2. **Google Gemini** (Recommended - Free)
   - Go to: https://ai.google.dev/
   - Sign in with Google
   - Create API key
   - 15 requests/minute for flash models

3. **Hugging Face**
   - Go to: https://huggingface.co/settings/tokens
   - Sign up for free
   - Create access token
   - Free serverless inference

4. **Mistral AI**
   - Go to: https://console.mistral.ai/
   - Sign up for free
   - Get free tier credits

5. **Together AI**
   - Go to: https://api.together.xyz/
   - Sign up
   - Get $25 free credits

6. **Perplexity**
   - Go to: https://www.perplexity.ai/
   - Sign up for free tier

### Paid Providers (Optional)

7. **DeepSeek** (Very Affordable)
   - Go to: https://platform.deepseek.com/
   - Sign up and add credits
   - ~$0.14/1M tokens (very cheap)

8. **Anthropic Claude**
   - Go to: https://console.anthropic.com/
   - Add billing
   - High quality, reliable

9. **Cohere**
   - Go to: https://dashboard.cohere.com/
   - Free trial available

10. **OpenAI**
    - Go to: https://platform.openai.com/
    - $5 minimum deposit
    - Most compatible

## Usage

### Start the Server

```bash
npm run admin
```

The admin panel will be at: http://localhost:8080

### Monitor AI Status

1. Open the admin panel
2. Click on **"🤖 AI Status"** tab
3. View:
   - Available providers
   - Health status for each provider
   - Success rates
   - Cost tracking
   - Token usage
   - Recent request history

### Testing Providers

In the AI Status tab:
- Click **"Test"** button next to any provider
- Click **"Reset"** to clear error states

## How Fallback Works

1. **Primary Provider Attempt** - Try the highest priority healthy provider
2. **Automatic Fallback** - If it fails, try the next available provider
3. **Rate Limit Handling** - Skip providers that are rate-limited
4. **Circuit Breaker** - Temporarily disable providers with 5+ consecutive failures
5. **Auto-Recovery** - Providers automatically recover after cooldown period

## API Endpoints

```bash
# Get AI statistics
GET /api/ai/stats

# Get provider status
GET /api/ai/providers

# Get request history
GET /api/ai/history?limit=50

# Reset provider health
POST /api/ai/providers/{name}/reset

# Test a provider
POST /api/ai/providers/{name}/test

# Get processor stats
GET /api/ai/processor/stats
```

## Troubleshooting

### No providers available

```
⚠️ AI Processor: No AI providers are available.
```

**Solution**: Add at least one API key to `.env` file.

### Provider shows "Down"

**Solution**: Click the **"Reset"** button in the AI Status tab to clear error states.

### Rate limit errors

**Solution**: Add more provider API keys. The system will automatically rotate providers.

### JSON parsing errors

**Solution**: The system automatically handles JSON parsing issues and tries the next provider.

## File Structure

```
ai-providers/
├── base-provider.js         # Base class for all providers
├── groq-provider.js         # Groq AI integration
├── gemini-provider.js       # Google Gemini integration
├── anthropic-provider.js    # Anthropic Claude integration
├── cohere-provider.js       # Cohere integration
├── mistral-provider.js      # Mistral AI integration
├── deepseek-provider.js     # DeepSeek integration
├── huggingface-provider.js  # Hugging Face integration
├── together-provider.js     # Together AI integration
├── perplexity-provider.js   # Perplexity integration
└── openai-provider.js       # OpenAI integration

ai-manager.js                # Main orchestration system
ai-processor.js              # Worker that uses AI manager
server.js                    # Updated with AI status endpoints
```

## Cost Estimation

For 1,000 website classifications:

| Provider | Est. Cost |
|----------|-----------|
| Groq | Free |
| Gemini | ~$0.0003 |
| DeepSeek | ~$0.0006 |
| OpenAI (gpt-4o-mini) | ~$0.0015 |
| Anthropic (Haiku) | ~$0.008 |

**Recommendation**: Use Groq (free) + Gemini (free) for 99% of requests at near-zero cost.

## Support

For issues or questions:
1. Check the AI Status tab in the admin panel
2. Review logs in the terminal
3. Verify API keys are correct in `.env`
4. Test each provider individually
