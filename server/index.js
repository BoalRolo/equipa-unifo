import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
// Configure CORS to allow requests from the frontend
const allowedOrigins = [
    "https://boalrolo.github.io",
    "http://localhost:5173",
    "http://localhost:3000",
    "http://localhost:5174"
];

// CORS middleware - must be before other middleware
app.use((req, res, next) => {
    const origin = req.headers.origin;
    
    // Check if origin is in allowed list
    if (origin && allowedOrigins.includes(origin)) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Credentials", "true");
    } else if (!origin) {
        // For requests with no origin, don't set credentials header
        res.setHeader("Access-Control-Allow-Origin", "*");
    } else {
        // For other origins, allow but without credentials
        res.setHeader("Access-Control-Allow-Origin", origin);
    }
    
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Max-Age", "86400"); // 24 hours
    
    // Handle preflight OPTIONS requests
    if (req.method === "OPTIONS") {
        return res.status(204).end();
    }
    
    next();
});

// Also use cors middleware as backup
const corsOptions = {
    origin: function (origin, callback) {
        if (!origin || allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            callback(null, true); // Allow all for now
        }
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    preflightContinue: false,
    optionsSuccessStatus: 204
};

app.use(cors(corsOptions));
// Increase payload size limit to 100MB (for large base64 encoded files)
// Note: Vercel has limits (10MB for Hobby, 4.5MB for Pro), so we may need to process in smaller batches
app.use(express.json({ limit: "100mb" }));
app.use(express.urlencoded({ limit: "100mb", extended: true }));

// Endpoint para autenticação
app.post("/api/xray/authenticate", async (req, res) => {
    try {
        const { xrayBaseUrl, clientId, clientSecret } = req.body;

        if (!xrayBaseUrl || !clientId || !clientSecret) {
            return res.status(400).json({
                error: "Missing required parameters: xrayBaseUrl, clientId, clientSecret",
            });
        }

        const response = await fetch(`${xrayBaseUrl}/api/v2/authenticate`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                client_id: clientId,
                client_secret: clientSecret,
            }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            return res.status(response.status).json({
                error: `Authentication failed: ${response.status} ${response.statusText}`,
                details: errorText,
            });
        }

        const data = await response.json();
        const token = typeof data === "string" ? data : data.token || data;

        res.json({ token });
    } catch (error) {
        console.error("Authentication error:", error);
        res.status(500).json({
            error: "Internal server error",
            message: error.message,
        });
    }
});

// Helper: infer content type from filename
function getContentTypeFromFilename(filename) {
    const ext = (filename || "").split(".").pop()?.toLowerCase();
    const mime = {
        png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
        mp4: "video/mp4", pdf: "application/pdf", txt: "text/plain", log: "text/plain",
        json: "application/json",
    };
    return mime[ext] || "application/octet-stream";
}

// Endpoint para importação
app.post("/api/xray/import", async (req, res) => {
    try {
        const { xrayBaseUrl, token, importData, existingEvidencesByTestKey } = req.body;

        if (!xrayBaseUrl || !token || !importData) {
            const missing = [];
            if (!xrayBaseUrl) missing.push("xrayBaseUrl");
            if (!token) missing.push("token");
            if (!importData) missing.push("importData");

            return res.status(400).json({
                error: `Missing required parameters: ${missing.join(", ")}`,
            });
        }

        // Deep clone so we don't mutate the original
        const payload = JSON.parse(JSON.stringify(importData));

        // For each test that has existing evidences, fetch attachments in parallel and prepend to evidence array
        if (existingEvidencesByTestKey && typeof existingEvidencesByTestKey === "object" && payload.tests) {
            for (const test of payload.tests) {
                const testKey = test.testKey;
                const existingList = existingEvidencesByTestKey[testKey];
                if (!Array.isArray(existingList) || existingList.length === 0) continue;

                const fetchOne = async (ev) => {
                    const url = `${xrayBaseUrl}/api/v1/attachments/${ev.id}`;
                    const attRes = await fetch(url, {
                        method: "GET",
                        headers: { Authorization: `Bearer ${token}` },
                    });
                    if (!attRes.ok) return null;
                    const buf = await attRes.arrayBuffer();
                    const base64 = Buffer.from(buf).toString("base64");
                    return {
                        data: base64,
                        filename: ev.filename || "attachment",
                        contentType: getContentTypeFromFilename(ev.filename),
                    };
                };

                const existingEvidenceItems = await Promise.all(existingList.map(fetchOne));
                const valid = existingEvidenceItems.filter(Boolean);
                const currentEvidence = test.evidences || test.evidence || [];
                test.evidence = [...valid, ...currentEvidence];
            }
        }

        // Xray API expects "evidence" (singular), not "evidences". Normalize so payload is valid Xray format.
        if (payload.tests) {
            for (const test of payload.tests) {
                const list = test.evidence || test.evidences || [];
                test.evidence = list;
                delete test.evidences;
            }
        }

        const response = await fetch(`${xrayBaseUrl}/api/v2/import/execution`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error("Xray import error:", response.status, errorText);
            return res.status(response.status).json({
                error: `Import failed: ${response.status} ${response.statusText}`,
                details: errorText,
            });
        }

        const data = await response.json();
        res.json(data);
    } catch (error) {
        console.error("Import error:", error);
        res.status(500).json({
            error: "Internal server error",
            message: error.message,
        });
    }
});

// Endpoint para atualizar Test Runs via GraphQL
app.post("/api/xray/update-test-runs-graphql", async (req, res) => {
    try {
        const { xrayBaseUrl, token, testRunUpdates } = req.body;

        if (!xrayBaseUrl || !token || !testRunUpdates || !Array.isArray(testRunUpdates)) {
            return res.status(400).json({
                error: "Missing required parameters: xrayBaseUrl, token, testRunUpdates (array)",
            });
        }

        // First, try to introspect the schema to find available mutations
        const schemaIntrospection = {
            query: `query {
                __type(name: "Mutation") {
                    fields {
                        name
                        description
                        args {
                            name
                            type {
                                name
                                kind
                                ofType {
                                    name
                                }
                            }
                        }
                    }
                }
            }`,
        };

        // Try common mutation names for updating test runs
        const possibleMutations = [
            "updateTestRun",
            "updateTestRunStatus",
            "updateTestExecution",
            "updateTestRunResult",
        ];

        let mutationInfo = {};
        try {
            const introResponse = await fetch(`${xrayBaseUrl}/api/v2/graphql`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify(schemaIntrospection),
            });

            if (introResponse.ok) {
                const introData = await introResponse.json();
                if (introData.data && introData.data.__type) {
                    const testRunMutations = introData.data.__type.fields
                        .filter((f) =>
                            f.name.toLowerCase().includes("testrun") ||
                            f.name.toLowerCase().includes("testrun")
                        );

                    // Store mutation info with their arguments
                    for (const mutation of testRunMutations) {
                        mutationInfo[mutation.name] = {
                            args: mutation.args.map((a) => ({
                                name: a.name,
                                type: a.type.name || (a.type.ofType && a.type.ofType.name) || "Unknown",
                            })),
                        };
                    }
                }
            }
        } catch (error) {
        }

        // Update test run status using GraphQL mutations
        // Note: Status is already updated via REST API, but GraphQL update may be needed to stop timer
        // Try to do all updates in a SINGLE GraphQL query using aliases (much more efficient!)
        const results = [];
        const errors = [];

        if (testRunUpdates.length === 0) {
            return res.json({
                success: true,
                results: [],
                summary: { total: 0, successful: 0, failed: 0 },
            });
        }

        const statusMutationName = "updateTestRunStatus";
        const statusMutationArgs = mutationInfo[statusMutationName]?.args || [];

        // Find the correct argument names
        const idArg = statusMutationArgs.find(a =>
            a.name === "testRunId" ||
            a.name === "id" ||
            a.name === "testRun" ||
            a.name.toLowerCase().includes("testrun") ||
            a.name.toLowerCase().includes("id")
        );
        const statusArg = statusMutationArgs.find(a =>
            a.name === "status" ||
            a.name.toLowerCase().includes("status")
        );

        if (!idArg || !statusArg) {
            return res.json({
                success: false,
                errors: testRunUpdates.map(u => ({
                    testRunId: u.testRunId,
                    error: "updateTestRunStatus mutation not available",
                })),
                summary: {
                    total: testRunUpdates.length,
                    successful: 0,
                    failed: testRunUpdates.length,
                },
            });
        }

        // Try to do all updates in a single GraphQL query using aliases
        try {
            // Build mutation with aliases for each test run
            const mutationParts = [];
            const variables = {};

            testRunUpdates.forEach((update, index) => {
                const alias = `update${index}`;
                const idVar = `${idArg.name}${index}`;
                const statusVar = `status${index}`;

                mutationParts.push(
                    `${alias}: ${statusMutationName}(${idArg.name}: $${idVar}, status: $${statusVar})`
                );

                variables[idVar] = update.testRunId;
                variables[statusVar] = update.status;
            });

            const variableDefs = testRunUpdates.map((_, i) =>
                `$${idArg.name}${i}: String!, $status${i}: String!`
            ).join(", ");

            const combinedMutation = {
                query: `mutation (${variableDefs}) {
                    ${mutationParts.join("\n                    ")}
                }`,
                variables,
            };

            const response = await fetch(`${xrayBaseUrl}/api/v2/graphql`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify(combinedMutation),
            });

            const responseText = await response.text();
            if (response.ok) {
                const data = JSON.parse(responseText);

                if (data.errors) {
                    // If there are errors, mark all as failed
                    testRunUpdates.forEach((update) => {
                        errors.push({
                            testRunId: update.testRunId,
                            error: `GraphQL error: ${JSON.stringify(data.errors)}`,
                        });
                    });
                } else if (data.data) {
                    // Check each result
                    testRunUpdates.forEach((update, index) => {
                        const alias = `update${index}`;
                        const result = data.data[alias];

                        if (result) {
                            results.push({
                                testRunId: update.testRunId,
                                success: true,
                            });
                        } else {
                            errors.push({
                                testRunId: update.testRunId,
                                error: "No result returned from GraphQL",
                            });
                        }
                    });
                }
            } else {
                // If single query fails, fallback to individual requests
                // Fallback: process individually
                for (const update of testRunUpdates) {
                    try {
                        const individualMutation = {
                            query: `mutation ($${idArg.name}: String!, $status: String!) {
                                ${statusMutationName}(
                                    ${idArg.name}: $${idArg.name}
                                    status: $status
                                )
                            }`,
                            variables: {
                                [idArg.name]: update.testRunId,
                                status: update.status,
                            },
                        };

                        const individualResponse = await fetch(`${xrayBaseUrl}/api/v2/graphql`, {
                            method: "POST",
                            headers: {
                                "Content-Type": "application/json",
                                Authorization: `Bearer ${token}`,
                            },
                            body: JSON.stringify(individualMutation),
                        });

                        const individualResponseText = await individualResponse.text();

                        if (individualResponse.ok) {
                            const individualData = JSON.parse(individualResponseText);
                            if (individualData.errors) {
                                errors.push({
                                    testRunId: update.testRunId,
                                    error: `GraphQL error: ${JSON.stringify(individualData.errors)}`,
                                });
                            } else if (individualData.data) {
                                results.push({
                                    testRunId: update.testRunId,
                                    success: true,
                                });
                            }
                        } else {
                            errors.push({
                                testRunId: update.testRunId,
                                error: `HTTP ${individualResponse.status}: ${individualResponseText.substring(0, 200)}`,
                            });
                        }
                    } catch (error) {
                        errors.push({
                            testRunId: update.testRunId,
                            error: error.message,
                        });
                    }
                }
            }
        } catch (error) {
            console.error(`GraphQL update error:`, error.message);
            // Mark all as failed
            testRunUpdates.forEach((update) => {
                errors.push({
                    testRunId: update.testRunId,
                    error: error.message,
                });
            });
        }

        const response = {
            success: results.length > 0,
            results,
            errors: errors.length > 0 ? errors : undefined,
            summary: {
                total: testRunUpdates.length,
                successful: results.length,
                failed: errors.length,
            },
        };

        res.json(response);
    } catch (error) {
        res.status(500).json({
            error: "Internal server error",
            message: error.message,
        });
    }
});

// Endpoint para validar Test Execution via GraphQL
app.post("/api/xray/validate-test-execution", async (req, res) => {
    try {
        const { xrayBaseUrl, token, testExecutionKey } = req.body;

        if (!xrayBaseUrl || !token || !testExecutionKey) {
            const missing = [];
            if (!xrayBaseUrl) missing.push("xrayBaseUrl");
            if (!token) missing.push("token");
            if (!testExecutionKey) missing.push("testExecutionKey");

            return res.status(400).json({
                error: `Missing required parameters: ${missing.join(", ")}`,
            });
        }

        // First request to get Test Execution info and total count
        const initialQuery = {
            query: `query ($jql: String!, $limit: Int!, $trLimit: Int!) {
                getTestExecutions(jql: $jql, limit: $limit) {
                    results {
                        jira(fields: ["key", "summary", "status"])
                        testRuns(limit: $trLimit) {
                            total
                            results {
                                id
                                status {
                                    name
                                    color
                                    description
                                }
                                assigneeId
                                executedById
                                startedOn
                                finishedOn
                                comment
                                test {
                                    jira(fields: ["key", "summary"])
                                    testType {
                                        name
                                    }
                                }
                                evidence {
                                    id
                                    filename
                                    size
                                }
                            }
                        }
                    }
                }
            }`,
            variables: {
                jql: `key=${testExecutionKey}`,
                limit: 1,
                trLimit: 100,
            },
        };

        const initialResponse = await fetch(`${xrayBaseUrl}/api/v2/graphql`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify(initialQuery),
        });

        if (!initialResponse.ok) {
            const errorText = await initialResponse.text();
            return res.status(initialResponse.status).json({
                error: `GraphQL request failed: ${initialResponse.status} ${initialResponse.statusText}`,
                details: errorText,
            });
        }

        const initialData = await initialResponse.json();

        // Verificar se a Test Execution existe
        if (
            !initialData.data ||
            !initialData.data.getTestExecutions ||
            !initialData.data.getTestExecutions.results ||
            initialData.data.getTestExecutions.results.length === 0
        ) {
            return res.status(404).json({
                error: `Test Execution ${testExecutionKey} not found`,
                valid: false,
            });
        }

        const testExecution = initialData.data.getTestExecutions.results[0];
        const totalTestRuns = testExecution.testRuns?.total || 0;
        let allTestRuns = testExecution.testRuns?.results || [];

        // Paginate to get all Test Runs if there are more than 100
        // Xray GraphQL uses cursor-based pagination with 'start' parameter
        if (totalTestRuns > 100) {
            const pageSize = 100;
            const totalPages = Math.ceil(totalTestRuns / pageSize);

            for (let page = 1; page < totalPages; page++) {
                const start = page * pageSize;

                const paginatedQuery = {
                    query: `query ($jql: String!, $limit: Int!, $trLimit: Int!, $trStart: Int!) {
                        getTestExecutions(jql: $jql, limit: $limit) {
                            results {
                                testRuns(limit: $trLimit, start: $trStart) {
                                    results {
                                        id
                                        status {
                                            name
                                            color
                                            description
                                        }
                                        assigneeId
                                        executedById
                                        startedOn
                                        finishedOn
                                        comment
                                        test {
                                            jira(fields: ["key", "summary"])
                                            testType {
                                                name
                                            }
                                        }
                                        evidence {
                                            id
                                            filename
                                            size
                                        }
                                    }
                                }
                            }
                        }
                    }`,
                    variables: {
                        jql: `key=${testExecutionKey}`,
                        limit: 1,
                        trLimit: pageSize,
                        trStart: start,
                    },
                };

                const paginatedResponse = await fetch(`${xrayBaseUrl}/api/v2/graphql`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        Authorization: `Bearer ${token}`,
                    },
                    body: JSON.stringify(paginatedQuery),
                });

                if (!paginatedResponse.ok) {
                    // Try to continue with what we have
                    break;
                }

                const paginatedData = await paginatedResponse.json();

                // Check for GraphQL errors
                if (paginatedData.errors) {
                    break;
                }

                const pageTestRuns = paginatedData.data?.getTestExecutions?.results[0]?.testRuns?.results || [];
                allTestRuns = allTestRuns.concat(pageTestRuns);

                // If we got fewer results than expected, we've reached the end
                if (pageTestRuns.length < pageSize) {
                    break;
                }
            }
        }

        // Parse jira field (it's a JSON string)
        let jiraData;
        try {
            jiraData = typeof testExecution.jira === 'string'
                ? JSON.parse(testExecution.jira)
                : testExecution.jira;
        } catch (e) {
            jiraData = testExecution.jira;
        }

        const foundTestExecutionKey = jiraData?.key || testExecutionKey;
        const testExecutionSummary = jiraData?.summary || "";
        // Extract status name from jira fields (status is a Jira field, not a GraphQL field)
        const testExecutionStatusName = jiraData?.status?.name || jiraData?.status || null;

        // Validate that Test Execution is in "Em Progresso" status
        if (testExecutionStatusName !== "Em Progresso") {
            return res.json({
                valid: false,
                error: `A Test Execution deve estar no status "In Progress" para permitir o upload de evidências. Status atual: "${testExecutionStatusName || "Desconhecido"}". Por favor, altere o status da Test Execution para "In Progress" antes de continuar.`,
                testExecution: {
                    key: foundTestExecutionKey,
                    summary: testExecutionSummary,
                    status: testExecutionStatusName,
                },
            });
        }

        // Parse jira fields in test runs and extract IDs and statuses
        const parsedTestRuns = allTestRuns.map((tr) => {
            let testJiraData;
            try {
                testJiraData = typeof tr.test?.jira === 'string'
                    ? JSON.parse(tr.test.jira)
                    : tr.test?.jira;
            } catch (e) {
                testJiraData = tr.test?.jira;
            }

            const evidenceList = Array.isArray(tr.evidence) ? tr.evidence : (tr.evidence ? [tr.evidence] : []);
            return {
                id: tr.id,
                status: tr.status?.name || "UNKNOWN",
                statusColor: tr.status?.color || "",
                statusDescription: tr.status?.description || "",
                assigneeId: tr.assigneeId,
                executedById: tr.executedById,
                startedOn: tr.startedOn,
                finishedOn: tr.finishedOn,
                comment: tr.comment,
                test: {
                    key: testJiraData?.key || "",
                    summary: testJiraData?.summary || "",
                    testType: tr.test?.testType?.name || "",
                },
                evidence: evidenceList.map((e) => ({
                    id: e.id,
                    filename: e.filename || "",
                    size: e.size != null ? e.size : 0,
                })),
            };
        });

        // Extract all test IDs and statuses for summary
        const testIdsAndStatuses = parsedTestRuns.map(tr => ({
            id: tr.id,
            testKey: tr.test.key,
            status: tr.status,
        }));

        // Calculate status summary
        const statusSummary = parsedTestRuns.reduce((acc, tr) => {
            const status = tr.status || "UNKNOWN";
            acc[status] = (acc[status] || 0) + 1;
            return acc;
        }, {});

        res.json({
            valid: true,
            testExecution: {
                key: foundTestExecutionKey,
                summary: testExecutionSummary,
                status: testExecutionStatusName,
            },
            testRuns: {
                total: totalTestRuns,
                results: parsedTestRuns,
            },
            testIdsAndStatuses: testIdsAndStatuses,
            statusSummary: statusSummary,
        });
    } catch (error) {
        res.status(500).json({
            error: "Internal server error",
            message: error.message,
        });
    }
});

// Health check
app.get("/health", (req, res) => {
    res.json({ status: "ok" });
});

// Export for Vercel serverless functions
export default app;

// Only listen on port when running locally
if (process.env.NODE_ENV !== "production" || process.env.VERCEL !== "1") {
    app.listen(PORT, () => {
        console.log(`Backend server running on http://localhost:${PORT}`);
    });
}

