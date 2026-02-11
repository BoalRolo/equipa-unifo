// src/services/xrayCloud.ts

export interface XrayAuthResponse {
  token: string;
}

export interface XrayEvidence {
  data: string; // base64 encoded file
  filename: string;
  contentType: string;
}

export interface XrayTest {
  testKey: string;
  status: "EXECUTING" | "FAILED" | "PASSED";
  start?: string; // Optional - omit to preserve original startedOn
  finish: string;
  evidences: XrayEvidence[];
  executedBy?: string; // Xray/Jira account ID of the user executing the test
}

export interface XrayImportRequest {
  testExecutionKey: string;
  tests: XrayTest[];
}

export interface XrayImportResponse {
  testExecIssue?: {
    id: string;
    key: string;
    self: string;
  };
  testIssues?: Array<{
    id: string;
    key: string;
    self: string;
  }>;
  info?: {
    summary: string;
  };
}

/**
 * Authenticates with Xray Cloud and returns a JWT token
 * Uses backend proxy to avoid CORS issues
 */
export async function authenticateXray(
  xrayBaseUrl: string,
  clientId: string,
  clientSecret: string
): Promise<string> {
  const backendUrl =
    import.meta.env.VITE_BACKEND_URL || "http://localhost:3001";
  const url = `${backendUrl}/api/xray/authenticate`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      xrayBaseUrl,
      clientId,
      clientSecret,
    }),
  });

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(
      errorData.error ||
        `Authentication failed: ${response.status} ${response.statusText}`
    );
  }

  const data = await response.json();
  return data.token;
}

/** Map of test key to existing evidence metadata (for merging on import) */
export type ExistingEvidencesByTestKey = Record<
  string,
  Array<{ id: string; filename: string; size?: number }>
>;

/**
 * Imports test execution and evidences to Xray Cloud
 * Uses backend proxy to avoid CORS issues.
 * If existingEvidencesByTestKey is provided, backend fetches those attachments and merges with new evidences.
 */
export async function importExecution(
  xrayBaseUrl: string,
  token: string,
  importData: XrayImportRequest,
  existingEvidencesByTestKey?: ExistingEvidencesByTestKey
): Promise<XrayImportResponse> {
  const backendUrl =
    import.meta.env.VITE_BACKEND_URL || "http://localhost:3001";
  const url = `${backendUrl}/api/xray/import`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        xrayBaseUrl,
        token,
        importData,
        ...(existingEvidencesByTestKey && Object.keys(existingEvidencesByTestKey).length > 0
          ? { existingEvidencesByTestKey }
          : {}),
      }),
    });

    if (!response.ok) {
      let errorMessage = `Import failed: ${response.status} ${response.statusText}`;
      
      if (response.status === 413) {
        errorMessage = "Payload muito grande. Tente fazer upload de menos ficheiros por vez ou use ficheiros menores.";
      } else if (response.status === 504) {
        errorMessage = "Timeout do servidor. O processamento demorou demasiado tempo. Tente fazer upload de menos ficheiros por vez.";
      } else {
        try {
          const errorData = await response.json();
          errorMessage = errorData.error || errorMessage;
        } catch (e) {
          const errorText = await response.text();
          if (errorText) {
            errorMessage = errorText.substring(0, 200);
          }
        }
      }
      
      throw new Error(errorMessage);
    }

    return await response.json();
  } catch (error: any) {
    // Handle network errors (CORS, timeout, etc.)
    if (error.name === "TypeError" && error.message.includes("fetch")) {
      if (error.message.includes("CORS")) {
        throw new Error("Erro CORS: O servidor não permite requisições do frontend. Contacte o administrador.");
      } else if (error.message.includes("Failed to fetch")) {
        throw new Error("Erro de rede: Não foi possível conectar ao servidor. Verifique a sua ligação à internet.");
      } else {
        throw new Error(`Erro de rede: ${error.message}`);
      }
    }
    // Re-throw other errors as-is
    throw error;
  }
}

/**
 * Updates test runs using GraphQL mutations
 * This allows better control over timer stopping
 */
export async function updateTestRunsViaGraphQL(
  xrayBaseUrl: string,
  token: string,
  testRunUpdates: Array<{
    testRunId: string;
    status: string;
  }>
): Promise<any> {
  const backendUrl =
    import.meta.env.VITE_BACKEND_URL || "http://localhost:3001";
  const url = `${backendUrl}/api/xray/update-test-runs-graphql`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        xrayBaseUrl,
        token,
        testRunUpdates,
      }),
    });

    if (!response.ok) {
      let errorMessage = `Failed to update test runs: ${response.status} ${response.statusText}`;
      
      if (response.status === 413) {
        errorMessage = "Payload muito grande. Tente fazer upload de menos ficheiros por vez.";
      } else if (response.status === 504) {
        errorMessage = "Timeout do servidor. O processamento demorou demasiado tempo.";
      } else {
        try {
          const errorData = await response.json();
          errorMessage = errorData.error || errorMessage;
        } catch (e) {
          const errorText = await response.text();
          if (errorText) {
            errorMessage = errorText.substring(0, 200);
          }
        }
      }
      
      throw new Error(errorMessage);
    }

    return await response.json();
  } catch (error: any) {
    // Handle network errors (CORS, timeout, etc.)
    if (error.name === "TypeError" && error.message.includes("fetch")) {
      if (error.message.includes("CORS")) {
        throw new Error("Erro CORS: O servidor não permite requisições do frontend. Contacte o administrador.");
      } else if (error.message.includes("Failed to fetch")) {
        throw new Error("Erro de rede: Não foi possível conectar ao servidor. Verifique a sua ligação à internet.");
      } else {
        throw new Error(`Erro de rede: ${error.message}`);
      }
    }
    // Re-throw other errors as-is
    throw error;
  }
}

export interface TestExecutionValidation {
  valid: boolean;
  testExecution?: {
    key: string;
    summary: string;
    status?: string | null;
  };
  testRuns?: {
    total: number;
    results: Array<{
      id: string;
      status: string;
      statusColor: string;
      statusDescription: string;
      assigneeId?: string;
      executedById?: string;
      startedOn?: string;
      finishedOn?: string;
      comment?: string;
      test: {
        key: string;
        summary: string;
        testType: string;
      };
      evidence?: Array<{ id: string; filename: string; size?: number }>;
    }>;
  };
  testIdsAndStatuses?: Array<{
    id: string;
    testKey: string;
    status: string;
  }>;
  statusSummary?: Record<string, number>;
  error?: string;
}

/**
 * Validates a Test Execution and retrieves all its test runs
 * Uses backend proxy to avoid CORS issues
 */
export async function validateTestExecution(
  xrayBaseUrl: string,
  token: string,
  testExecutionKey: string
): Promise<TestExecutionValidation> {
  const backendUrl =
    import.meta.env.VITE_BACKEND_URL || "http://localhost:3001";
  const url = `${backendUrl}/api/xray/validate-test-execution`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      xrayBaseUrl,
      token,
      testExecutionKey,
    }),
  });

  // Check content type before parsing
  const contentType = response.headers.get("content-type");

  if (!response.ok) {
    let errorMessage = `Validation failed: ${response.status} ${response.statusText}`;

    try {
      if (contentType && contentType.includes("application/json")) {
        const errorData = await response.json();
        errorMessage = errorData.error || errorMessage;
      } else {
        const errorText = await response.text();
        errorMessage = `Server returned HTML instead of JSON. This usually means the endpoint doesn't exist or the backend isn't running. Status: ${response.status}`;
      }
    } catch (parseError: any) {
      errorMessage = `Failed to parse error response: ${parseError.message}`;
    }

    throw new Error(errorMessage);
  }

  // Verify we're getting JSON
  if (!contentType || !contentType.includes("application/json")) {
    throw new Error(
      "Server returned non-JSON response. Please check if the backend is running correctly and the endpoint exists."
    );
  }

  let data;
  try {
    data = await response.json();
  } catch (parseError: any) {
    throw new Error(
      "Failed to parse server response as JSON. The backend may have returned an error page."
    );
  }

  return data;
}
