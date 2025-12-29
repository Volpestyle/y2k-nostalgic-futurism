package ai

import (
	"os"
	"strings"
	"time"

	inferencekit "github.com/Volpestyle/inference-kit/packages/go"
)

func NewHubFromEnv() (*inferencekit.Hub, error) {
	cfg := inferencekit.Config{}
	hasProvider := false

	openAIKey := envFirst("INFERENCE_KIT_OPENAI_API_KEY", "OPENAI_API_KEY")
	openAIKeys := splitCSV(os.Getenv("INFERENCE_KIT_OPENAI_API_KEYS"))
	if openAIKey != "" || len(openAIKeys) > 0 {
		cfg.OpenAI = &inferencekit.OpenAIConfig{
			APIKey:              openAIKey,
			APIKeys:             openAIKeys,
			BaseURL:             strings.TrimSpace(os.Getenv("INFERENCE_KIT_OPENAI_BASE_URL")),
			Organization:        strings.TrimSpace(os.Getenv("INFERENCE_KIT_OPENAI_ORG")),
			DefaultUseResponses: envBool("INFERENCE_KIT_OPENAI_USE_RESPONSES", true),
		}
		hasProvider = true
	}

	anthropicKey := envFirst("INFERENCE_KIT_ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY")
	anthropicKeys := splitCSV(os.Getenv("INFERENCE_KIT_ANTHROPIC_API_KEYS"))
	if anthropicKey != "" || len(anthropicKeys) > 0 {
		cfg.Anthropic = &inferencekit.AnthropicConfig{
			APIKey:  anthropicKey,
			APIKeys: anthropicKeys,
			BaseURL: strings.TrimSpace(os.Getenv("INFERENCE_KIT_ANTHROPIC_BASE_URL")),
			Version: strings.TrimSpace(os.Getenv("INFERENCE_KIT_ANTHROPIC_VERSION")),
		}
		hasProvider = true
	}

	xaiKey := envFirst("INFERENCE_KIT_XAI_API_KEY", "XAI_API_KEY")
	xaiKeys := splitCSV(os.Getenv("INFERENCE_KIT_XAI_API_KEYS"))
	if xaiKey != "" || len(xaiKeys) > 0 {
		cfg.XAI = &inferencekit.XAIConfig{
			APIKey:            xaiKey,
			APIKeys:           xaiKeys,
			BaseURL:           strings.TrimSpace(os.Getenv("INFERENCE_KIT_XAI_BASE_URL")),
			CompatibilityMode: strings.TrimSpace(os.Getenv("INFERENCE_KIT_XAI_COMPATIBILITY")),
		}
		hasProvider = true
	}

	googleKey := envFirst("INFERENCE_KIT_GOOGLE_API_KEY", "GOOGLE_API_KEY")
	googleKeys := splitCSV(os.Getenv("INFERENCE_KIT_GOOGLE_API_KEYS"))
	if googleKey != "" || len(googleKeys) > 0 {
		cfg.Google = &inferencekit.GoogleConfig{
			APIKey:  googleKey,
			APIKeys: googleKeys,
			BaseURL: strings.TrimSpace(os.Getenv("INFERENCE_KIT_GOOGLE_BASE_URL")),
		}
		hasProvider = true
	}

	if !hasProvider && !inferencekit.HasCatalogModels() {
		return nil, nil
	}

	if raw := strings.TrimSpace(os.Getenv("INFERENCE_KIT_REGISTRY_TTL")); raw != "" {
		if ttl, err := time.ParseDuration(raw); err == nil {
			cfg.RegistryTTL = ttl
		}
	}

	return inferencekit.New(cfg)
}

func splitCSV(raw string) []string {
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		trimmed := strings.TrimSpace(part)
		if trimmed == "" {
			continue
		}
		out = append(out, trimmed)
	}
	return out
}

func envFirst(keys ...string) string {
	for _, key := range keys {
		value := strings.TrimSpace(os.Getenv(key))
		if value != "" {
			return value
		}
	}
	return ""
}

func envBool(key string, fallback bool) bool {
	raw := strings.TrimSpace(strings.ToLower(os.Getenv(key)))
	if raw == "" {
		return fallback
	}
	return raw == "1" || raw == "true" || raw == "yes" || raw == "on"
}
