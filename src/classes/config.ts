/**
 * Configuration management for AI Documenter
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';
import { DocumenterConfig, DefaultDocumenterConfig } from '../types';
import { ConfigurationError, getErrorMessage } from '../classes/errors';
import { validateConfig, DocumenterConfigSchema } from '../helpers/validation';

/**
 * Configuration builder pattern for clean config assembly
 */
class ConfigBuilder {
  private config: Partial<DocumenterConfig> = {};

  /**
   * Start with default configuration values
   */
  withDefaults(): ConfigBuilder {
    const defaults: DefaultDocumenterConfig = {
      provider: 'openai',
      openai_model: 'gpt-4o-mini',
      lmstudio_endpoint: 'http://localhost:1234/v1',
      lmstudio_model: 'local-model',
      max_conversation_history: 10,
      default_output_dir: './docs',
      timeout: 3600000, // 1 hour timeout
    };

    this.config = { ...this.config, ...defaults };
    return this;
  }

  /**
   * Apply environment variable configuration
   */
  withEnvironment(): ConfigBuilder {
    const envConfig: Partial<DocumenterConfig> = {};

    // Provider selection
    if (process.env.LLM_PROVIDER) {
      const provider = process.env.LLM_PROVIDER.toLowerCase();
      if (provider === 'openai' || provider === 'lmstudio') {
        envConfig.provider = provider as 'openai' | 'lmstudio';
      }
    }

    // OpenAI configuration
    if (process.env.OPENAI_API_KEY) {
      envConfig.openai_api_key = process.env.OPENAI_API_KEY;
    }
    if (process.env.OPENAI_MODEL) {
      envConfig.openai_model = process.env.OPENAI_MODEL;
    }

    // LMStudio configuration
    if (process.env.LMSTUDIO_ENDPOINT) {
      envConfig.lmstudio_endpoint = process.env.LMSTUDIO_ENDPOINT;
    }
    if (process.env.LMSTUDIO_MODEL) {
      envConfig.lmstudio_model = process.env.LMSTUDIO_MODEL;
    }

    // Common settings
    if (process.env.MAX_CONVERSATION_HISTORY) {
      const value = parseInt(process.env.MAX_CONVERSATION_HISTORY, 10);
      if (!isNaN(value) && value > 0) {
        envConfig.max_conversation_history = value;
      }
    }

    if (process.env.DEFAULT_OUTPUT_DIR) {
      envConfig.default_output_dir = process.env.DEFAULT_OUTPUT_DIR;
    }

    if (process.env.LLM_TIMEOUT) {
      const value = parseInt(process.env.LLM_TIMEOUT, 10);
      if (!isNaN(value) && value > 0) {
        envConfig.timeout = value;
      }
    }

    // Merge environment config, overriding existing values
    this.config = { ...this.config, ...envConfig };
    return this;
  }

  /**
   * Apply file-based configuration
   */
  withFile(fileConfig: Partial<DocumenterConfig>): ConfigBuilder {
    this.config = { ...this.config, ...fileConfig };
    return this;
  }

  /**
   * Build and validate the final configuration
   */
  build(): DocumenterConfig {
    // Ensure required fields are present based on provider
    if (!this.config.provider) {
      throw new ConfigurationError('Provider must be specified');
    }

    // Validate using Zod schema
    const validatedConfig = validateConfig(DocumenterConfigSchema, this.config, 'final');

    // Additional provider-specific validation
    this.validateProviderRequirements(validatedConfig);

    return validatedConfig;
  }

  /**
   * Validate provider-specific requirements
   */
  private validateProviderRequirements(config: DocumenterConfig): void {
    if (config.provider === 'openai' && !config.openai_api_key) {
      throw new ConfigurationError(
        'OpenAI API key is required when using OpenAI provider. ' +
          'Set OPENAI_API_KEY environment variable or add it to your config file.',
        { provider: config.provider }
      );
    }

    if (config.provider === 'lmstudio') {
      if (config.lmstudio_endpoint) {
        try {
          new URL(config.lmstudio_endpoint);
        } catch {
          throw new ConfigurationError(
            `Invalid LMStudio endpoint URL: ${config.lmstudio_endpoint}`,
            { provider: config.provider, endpoint: config.lmstudio_endpoint }
          );
        }
      }
    }
  }

  /**
   * Get current config state (for debugging)
   */
  getCurrentState(): Partial<DocumenterConfig> {
    return { ...this.config };
  }
}

export class ConfigManager {
  private config: DocumenterConfig | null = null;
  private static _instance: ConfigManager | null = null;

  constructor() {
    // Allow direct instantiation for testing and dependency injection
  }

  /**
   * Get singleton instance of ConfigManager (for backwards compatibility)
   */
  static getInstance(): ConfigManager {
    if (!ConfigManager._instance) {
      ConfigManager._instance = new ConfigManager();
    }
    return ConfigManager._instance;
  }

  /**
   * Load environment variables from multiple possible locations
   */
  private loadEnvConfig(): void {
    // Try to load from current working directory first
    const cwd = process.cwd();
    const localEnvPath = path.join(cwd, '.env');

    try {
      dotenv.config({ path: localEnvPath });
    } catch {
      // If no local .env, try the global one in the home directory
      const homeDir = process.env.HOME || process.env.USERPROFILE || '';
      const globalEnvPath = path.join(homeDir, '.documenter', '.env');
      try {
        dotenv.config({ path: globalEnvPath });
      } catch {
        // Finally, try to load from package directory (fallback)
        dotenv.config();
      }
    }
  }

  /**
   * Load configuration from config files
   */
  private async loadFromFiles(): Promise<Partial<DocumenterConfig>> {
    const cwd = process.cwd();
    const configPaths = [
      path.join(cwd, '.documenter.json'),
      path.join(cwd, 'documenter.config.json'),
    ];

    for (const configPath of configPaths) {
      try {
        const configFile = await fs.readFile(configPath, 'utf-8');
        const fileConfig = JSON.parse(configFile);

        // Validate the config file structure
        try {
          validateConfig(DocumenterConfigSchema, fileConfig, 'file');
          return fileConfig;
        } catch (validationError) {
          throw new ConfigurationError(
            `Invalid configuration in ${configPath}: ${getErrorMessage(validationError)}`,
            { configPath, originalError: validationError }
          );
        }
      } catch (error) {
        if (error instanceof ConfigurationError) {
          throw error;
        }
        // Config file doesn't exist or has JSON syntax error, continue to next
        if (error instanceof SyntaxError) {
          throw new ConfigurationError(
            `Invalid JSON in configuration file ${configPath}: ${error.message}`,
            { configPath, originalError: error }
          );
        }
      }
    }

    return {};
  }

  /**
   * Load and validate the complete configuration using ConfigBuilder
   */
  async loadConfig(): Promise<DocumenterConfig> {
    try {
      // Load environment variables
      this.loadEnvConfig();

      // Build configuration using the builder pattern
      const fileConfig = await this.loadFromFiles();

      const config = new ConfigBuilder()
        .withDefaults()
        .withEnvironment()
        .withFile(fileConfig)
        .build();

      this.config = config;
      return config;
    } catch (error) {
      if (error instanceof ConfigurationError) {
        throw error;
      }
      throw new ConfigurationError(`Failed to load configuration: ${getErrorMessage(error)}`, {
        originalError: error,
      });
    }
  }

  /**
   * Get the current configuration (load if not already loaded)
   */
  async getConfig(): Promise<DocumenterConfig> {
    if (!this.config) {
      return this.loadConfig();
    }
    return this.config;
  }

  /**
   * Reset the configuration (useful for testing)
   */
  reset(): void {
    this.config = null;
  }

  /**
   * Check if configuration is valid for the specified provider
   */
  async isValidForProvider(provider: 'openai' | 'lmstudio'): Promise<boolean> {
    try {
      const config = await this.getConfig();
      if (config.provider !== provider) {
        return false;
      }

      if (provider === 'openai') {
        return !!config.openai_api_key;
      }

      if (provider === 'lmstudio') {
        return !!config.lmstudio_endpoint && !!config.lmstudio_model;
      }

      return false;
    } catch {
      return false;
    }
  }

  /**
   * Get configuration summary for display (with sensitive data sanitized)
   */
  async getConfigSummary(): Promise<{
    provider: string;
    model: string;
    endpoint?: string;
    workingDir: string;
  }> {
    const config = await this.getConfig();

    const summary = {
      provider: config.provider || 'openai',
      model:
        config.provider === 'lmstudio'
          ? config.lmstudio_model || 'local-model'
          : config.openai_model || 'gpt-4o-mini',
      workingDir: process.cwd(),
    };

    if (config.provider === 'lmstudio' && config.lmstudio_endpoint) {
      return {
        ...summary,
        endpoint: config.lmstudio_endpoint,
      };
    }

    return summary;
  }

  /**
   * Create a sanitized version of config for logging (removes sensitive data)
   */
  sanitizeConfigForLogging(config: DocumenterConfig): Partial<DocumenterConfig> {
    const sanitized = { ...config };

    if (sanitized.openai_api_key) {
      sanitized.openai_api_key = '[REDACTED]';
    }

    return sanitized;
  }
}

// Export singleton instance
export const configManager = ConfigManager.getInstance();

// Export ConfigBuilder for direct use and testing
export { ConfigBuilder };
