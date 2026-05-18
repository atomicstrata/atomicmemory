/**
 * @file Runtime Configuration
 *
 * Centralized runtime configuration for the SDK.
 * This module provides a type-safe way to access environment-specific settings.
 * It MUST be initialized with configuration values, typically from the SDK constructor.
 * It DOES NOT read process.env directly.
 */

/** Environment configuration consumed by `RuntimeConfig`. */
interface EnvironmentConfig {
  environment: 'development' | 'production' | 'test';
  useOnchainSim: boolean;
  allowWeakCrypto: boolean;
  allowRemoteModels: boolean;
  tolerance: {
    mode: 'STRICT' | 'BALANCED' | 'RELAXED';
    recall: number;
    ndcg: number;
    top1Preservation: number;
    maxTransformTime: number;
    maxOverheadRatio: number;
  };
}

export class RuntimeConfig {
    private static instance: RuntimeConfig;
    private config: EnvironmentConfig;

    private constructor() {
        // Default safe configuration if not initialized
        this.config = {
            environment: 'development',
            useOnchainSim: false,
            allowWeakCrypto: false,
            allowRemoteModels: false,
            tolerance: {
                mode: 'STRICT',
                recall: 0,
                ndcg: 0,
                top1Preservation: 0,
                maxTransformTime: 0,
                maxOverheadRatio: 0,
            },
        };
    }

    public static getInstance(): RuntimeConfig {
        if (!RuntimeConfig.instance) {
            RuntimeConfig.instance = new RuntimeConfig();
        }
        return RuntimeConfig.instance;
    }

    /**
     * Initialize the runtime configuration with provided values.
     * This should be called once at SDK initialization.
     */
    // fallow-ignore-next-line unused-class-member
    public initialize(config: Partial<EnvironmentConfig>): void {
        this.config = {
            ...this.config,
            ...config,
            tolerance: {
                ...this.config.tolerance,
                ...(config.tolerance || {}),
            },
        };
    }

    /**
     * Reset configuration to defaults (useful for testing)
     */
    // fallow-ignore-next-line unused-class-member
    public reset(): void {
        this.config = {
            environment: 'development',
            useOnchainSim: false,
            allowWeakCrypto: false,
            allowRemoteModels: false,
            tolerance: {
                mode: 'STRICT',
                recall: 0,
                ndcg: 0,
                top1Preservation: 0,
                maxTransformTime: 0,
                maxOverheadRatio: 0,
            },
        };
    }

    // fallow-ignore-next-line unused-class-member
    get environment(): 'development' | 'production' | 'test' {
        return this.config.environment;
    }

    // fallow-ignore-next-line unused-class-member
    get toleranceConfig() {
        return this.config.tolerance;
    }

    // fallow-ignore-next-line unused-class-member
    get useOnchainSim(): boolean {
        return this.config.useOnchainSim;
    }

    // fallow-ignore-next-line unused-class-member
    get allowWeakCrypto(): boolean {
        return this.config.allowWeakCrypto;
    }

    // fallow-ignore-next-line unused-class-member
    get allowRemoteModels(): boolean {
        return this.config.allowRemoteModels;
    }

    /**
     * Helper to get tolerance configuration in the format expected by ToleranceConfig
     */
    // fallow-ignore-next-line unused-class-member
    getToleranceConfig() {
        return {
            toleranceMode: this.config.tolerance.mode,
            recallTolerance: this.config.tolerance.recall,
            ndcgTolerance: this.config.tolerance.ndcg,
            top1PreservationRate: this.config.tolerance.top1Preservation,
            maxTransformTime: this.config.tolerance.maxTransformTime,
            maxOverheadRatio: this.config.tolerance.maxOverheadRatio,
        };
    }
}

export const runtimeConfig = RuntimeConfig.getInstance();
