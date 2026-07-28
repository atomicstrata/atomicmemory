/**
 * Outbound runtime heartbeat to Cloud (amc_ auth + core_instance_id).
 */

import { cloudApiPost } from './cloud-api-client.js';
import type { CloudRuntimeHeartbeatPayload } from './types.js';

export interface SendRuntimeHeartbeatInput {
  apiUrl: string;
  apiKey: string;
  payload: CloudRuntimeHeartbeatPayload;
}

export interface SendRuntimeHeartbeatResult {
  ok: boolean;
  status: number;
  errorCode: string | null;
}

export async function sendRuntimeHeartbeat(
  input: SendRuntimeHeartbeatInput,
): Promise<SendRuntimeHeartbeatResult> {
  try {
    const response = await cloudApiPost({
      apiUrl: input.apiUrl,
      apiKey: input.apiKey,
      path: '/v1/runtimes/heartbeat',
      body: input.payload,
    });
    if (response.ok) {
      return { ok: true, status: response.status, errorCode: null };
    }
    return {
      ok: false,
      status: response.status,
      errorCode: response.status === 401 || response.status === 403 ? `auth_${response.status}` : `http_${response.status}`,
    };
  } catch {
    return { ok: false, status: 0, errorCode: 'network_error' };
  }
}
