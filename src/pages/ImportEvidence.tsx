import React, { useState, useRef, useEffect } from "react";
import { useDarkMode } from "../contexts/DarkModeContext";
import Header from "../components/Header";
import {
  authenticateXray,
  importExecution,
  validateTestExecution,
  updateTestRunsViaGraphQL,
  XrayTest,
  XrayEvidence,
  XrayImportRequest,
  TestExecutionValidation,
} from "../services/xrayCloud";

interface FileWithTestRun {
  file: File;
  testRunNumber: string;
  testKey: string;
}

interface GroupedFiles {
  [testRunNumber: string]: FileWithTestRun[];
}

interface IgnoredFile {
  file: File;
  reason:
    | "invalid_format"
    | "test_not_found"
    | "test_not_executing"
    | "system_file"
    | "file_too_large";
  reasonText: string;
  testRunNumber?: string;
}

export default function ImportEvidence() {
  const { isDarkMode } = useDarkMode();
  const [testExecutionKey, setTestExecutionKey] = useState("");
  const [testExecutionNumber, setTestExecutionNumber] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [invalidFiles, setInvalidFiles] = useState<File[]>([]);
  const [ignoredFiles, setIgnoredFiles] = useState<IgnoredFile[]>([]);
  const [groupedFiles, setGroupedFiles] = useState<GroupedFiles>({});
  const [isProcessing, setIsProcessing] = useState(false);
  const [isValidating, setIsValidating] = useState(false);
  const [validationResult, setValidationResult] =
    useState<TestExecutionValidation | null>(null);
  const [executingTestRunIds, setExecutingTestRunIds] = useState<Set<string>>(
    new Set()
  );
  const [testRunInfoMap, setTestRunInfoMap] = useState<
    Map<string, { id: string; startedOn?: string }>
  >(new Map());
  const [result, setResult] = useState<{
    success: boolean;
    message: string;
    details?: any;
  } | null>(null);
  const [progress, setProgress] = useState<{
    current: number;
    total: number;
    message: string;
    stage: "rest" | "graphql" | "complete";
    completed: string[];
    inProgress: string[];
    failed: Array<{ testRun: string; error: string }>;
    animatedProgress: number; // For smooth animation
    dynamicMessage: string; // Rotating messages
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (progress) {
      const originalOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";

      return () => {
        document.body.style.overflow = originalOverflow;
      };
    }
  }, [progress]);
  const [uploadMode, setUploadMode] = useState<"files" | "folder">("folder");
  const [expandedTestRuns, setExpandedTestRuns] = useState<Set<string>>(
    new Set()
  );

  const xrayBaseUrl = import.meta.env.VITE_XRAY_BASE_URL || "";
  const clientId = import.meta.env.VITE_XRAY_CLIENT_ID || "";
  const clientSecret = import.meta.env.VITE_XRAY_CLIENT_SECRET || "";

  const extractTestRunNumber = (filename: string): string | null => {
    const match = filename.match(/^(?:UAAS-)?(\d+)(?:-.*)?\./);
    return match ? match[1] : null;
  };

  // File size limits (in bytes)
  const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB - files larger than this will be rejected
  const COMPRESS_THRESHOLD = 3 * 1024 * 1024; // 3MB - files larger than this will be compressed

  /**
   * Compresses an image file to reduce its size
   * @param file - The image file to compress
   * @param maxWidth - Maximum width (default: 1920)
   * @param maxHeight - Maximum height (default: 1080)
   * @param quality - JPEG quality 0.0-1.0 (default: 0.85)
   * @returns Base64 string of compressed image
   */
  const compressImage = (
    file: File,
    maxWidth: number = 1920,
    maxHeight: number = 1080,
    quality: number = 0.85
  ): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement("canvas");
          let width = img.width;
          let height = img.height;

          // Calculate new dimensions while maintaining aspect ratio
          if (width > maxWidth || height > maxHeight) {
            const ratio = Math.min(maxWidth / width, maxHeight / height);
            width = width * ratio;
            height = height * ratio;
          }

          canvas.width = width;
          canvas.height = height;

          const ctx = canvas.getContext("2d");
          if (!ctx) {
            reject(new Error("Could not get canvas context"));
            return;
          }

          ctx.drawImage(img, 0, 0, width, height);

          // Convert to JPEG for better compression (PNG is lossless and larger)
          canvas.toBlob(
            (blob) => {
              if (!blob) {
                reject(new Error("Failed to compress image"));
                return;
              }
              const reader = new FileReader();
              reader.onload = () => {
                const base64 = (reader.result as string).split(",")[1];
                resolve(base64);
              };
              reader.onerror = reject;
              reader.readAsDataURL(blob);
            },
            "image/jpeg",
            quality
          );
        };
        img.onerror = reject;
        img.src = e.target?.result as string;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  };

  /**
   * Converts a file to base64, with automatic compression for large image files
   * @param file - The file to convert
   * @returns Base64 string and whether compression was applied
   */
  const fileToBase64 = async (
    file: File
  ): Promise<{ base64: string; wasCompressed: boolean }> => {
    const extension = file.name.split(".").pop()?.toLowerCase();
    const isImage = ["png", "jpg", "jpeg", "gif", "webp"].includes(
      extension || ""
    );

    // If it's an image and larger than threshold, compress it
    if (isImage && file.size > COMPRESS_THRESHOLD) {
      try {
        const compressedBase64 = await compressImage(file);
        return { base64: compressedBase64, wasCompressed: true };
      } catch (error) {
        // If compression fails, fall back to original
        console.warn("Image compression failed, using original:", error);
      }
    }

    // For non-images or small images, use original method
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = (reader.result as string).split(",")[1];
        resolve({ base64, wasCompressed: false });
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  };

  const getContentType = (filename: string): string => {
    const extension = filename.split(".").pop()?.toLowerCase();
    const mimeTypes: { [key: string]: string } = {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      mp4: "video/mp4",
      txt: "text/plain",
      log: "text/plain",
      pdf: "application/pdf",
      json: "application/json",
    };
    return mimeTypes[extension || ""] || "application/octet-stream";
  };

  const processFiles = (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;

    const fileArray = Array.from(fileList);
    const grouped: GroupedFiles = {};
    const processedFiles: File[] = [];
    const invalid: File[] = [];
    const notExecutingFiles: File[] = [];
    const ignored: IgnoredFile[] = [];

    const systemFiles = [
      ".DS_Store",
      "Thumbs.db",
      ".gitkeep",
      ".gitignore",
      "desktop.ini",
    ];

    const hasExecutingTests = executingTestRunIds.size > 0;

    const testRunNumberToIdMap = new Map<string, string>();
    const testRunNumberToInfoMap = new Map<
      string,
      { id: string; startedOn?: string }
    >();
    if (validationResult?.testRuns?.results) {
      validationResult.testRuns.results.forEach((tr) => {
        const testKey = tr.test?.key || "";
        const match = testKey.match(/UAAS-(\d+)/);
        if (match) {
          const testRunNumber = match[1];
          testRunNumberToIdMap.set(testRunNumber, tr.id);
          testRunNumberToInfoMap.set(testRunNumber, {
            id: tr.id,
            startedOn: tr.startedOn,
          });
        }
      });
    }

    fileArray.forEach((file) => {
      const fileName =
        file.name.split("/").pop() || file.name.split("\\").pop() || file.name;

      const isSystemFile = systemFiles.some(
        (sysFile) =>
          fileName === sysFile ||
          fileName.toLowerCase() === sysFile.toLowerCase()
      );

      if (isSystemFile) {
        return;
      }

      // Check file size - reject files that are too large
      if (file.size > MAX_FILE_SIZE) {
        const sizeInMB = (file.size / (1024 * 1024)).toFixed(2);
        ignored.push({
          file,
          reason: "file_too_large",
          reasonText: `Ficheiro demasiado grande (${sizeInMB}MB). O tamanho máximo permitido é 10MB.`,
        });
        return;
      }

      const testRunNumber = extractTestRunNumber(fileName);

      if (!testRunNumber) {
        ignored.push({
          file,
          reason: "invalid_format",
          reasonText:
            "Formato de nome incorreto. Deve seguir: UAAS-<número>.extensão, UAAS-<número>-qualquer_coisa.extensão, <número>.extensão ou <número>-qualquer_coisa.extensão",
        });
        invalid.push(file);
        return;
      }

      const testRunId = testRunNumberToIdMap.get(testRunNumber);

      if (!testRunId) {
        ignored.push({
          file,
          reason: "test_not_found",
          reasonText: `O Test Run UAAS-${testRunNumber} não existe nesta Test Execution`,
          testRunNumber,
        });
        return;
      }

      if (hasExecutingTests) {
        if (executingTestRunIds.has(testRunId)) {
          const testKey = `UAAS-${testRunNumber}`;
          if (!grouped[testRunNumber]) {
            grouped[testRunNumber] = [];
          }
          grouped[testRunNumber].push({
            file,
            testRunNumber,
            testKey,
          });
          processedFiles.push(file);
        } else {
          ignored.push({
            file,
            reason: "test_not_executing",
            reasonText: `O Test Run UAAS-${testRunNumber} não está em estado EXECUTING`,
            testRunNumber,
          });
          notExecutingFiles.push(file);
        }
      } else {
        ignored.push({
          file,
          reason: "test_not_executing",
          reasonText: `O Test Run UAAS-${testRunNumber} não está em estado EXECUTING`,
          testRunNumber,
        });
        notExecutingFiles.push(file);
      }
    });

    setFiles(processedFiles);
    setInvalidFiles(invalid);
    setIgnoredFiles(ignored);
    setGroupedFiles(grouped);
    setTestRunInfoMap(testRunNumberToInfoMap);
    setResult(null);

    if (notExecutingFiles.length > 0) {
      setResult({
        success: false,
        message: `Não é possível fazer upload de ${notExecutingFiles.length} ficheiro(s). Estes ficheiros correspondem a Test Runs que não estão em estado EXECUTING. Apenas Test Runs em EXECUTING podem receber evidências.`,
      });
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!validationResult?.valid) {
      setResult({
        success: false,
        message:
          "Por favor, valide a Test Execution antes de fazer upload de evidências.",
      });
      if (e.target) {
        e.target.value = "";
      }
      return;
    }

    const executingCount =
      validationResult?.statusSummary?.["EXECUTING"] ||
      validationResult?.statusSummary?.["IN PROGRESS"] ||
      0;
    const hasExecutingTests = executingCount > 0;

    if (!hasExecutingTests) {
      setResult({
        success: false,
        message:
          "Não é possível fazer upload. Apenas testes em estado EXECUTING podem receber evidências.",
      });
      if (e.target) {
        e.target.value = "";
      }
      return;
    }

    processFiles(e.target.files);
  };

  const handleUploadClick = () => {
    if (!validationResult?.valid) {
      setResult({
        success: false,
        message:
          "Por favor, valide a Test Execution antes de fazer upload de evidências.",
      });
      return;
    }

    const executingCount =
      validationResult?.statusSummary?.["EXECUTING"] ||
      validationResult?.statusSummary?.["IN PROGRESS"] ||
      0;
    const hasExecutingTests = executingCount > 0;

    if (!hasExecutingTests) {
      setResult({
        success: false,
        message:
          "Não é possível fazer upload. Apenas testes em estado EXECUTING podem receber evidências.",
      });
      return;
    }

    if (uploadMode === "folder" && folderInputRef.current) {
      folderInputRef.current.click();
    } else if (fileInputRef.current) {
      fileInputRef.current.click();
    }
  };

  const validateTestExecutionKey = async (number: string) => {
    if (!number.trim()) {
      setValidationResult(null);
      setTestExecutionKey("");
      return;
    }

    if (!xrayBaseUrl || !clientId || !clientSecret) {
      setValidationResult({
        valid: false,
        error:
          "As credenciais do Xray Cloud não estão configuradas. Verifique as variáveis de ambiente VITE_XRAY_BASE_URL, VITE_XRAY_CLIENT_ID e VITE_XRAY_CLIENT_SECRET.",
      });
      setTestExecutionKey("");
      console.error("Variáveis de ambiente não configuradas:", {
        xrayBaseUrl: !!xrayBaseUrl,
        clientId: !!clientId,
        clientSecret: !!clientSecret,
      });
      return;
    }

    setIsValidating(true);
    setValidationResult(null);
    setResult(null);

    try {
      console.log("Iniciando validação...", {
        number,
        xrayBaseUrl: xrayBaseUrl ? "SET" : "MISSING",
        clientId: clientId ? "SET" : "MISSING",
        backendUrl: import.meta.env.VITE_BACKEND_URL || "MISSING",
      });

      const token = await authenticateXray(xrayBaseUrl, clientId, clientSecret);
      console.log("Autenticação bem-sucedida");

      const cleanNumber = number
        .trim()
        .replace(/^UAAS-?/i, "")
        .replace(/[^0-9]/g, "");
      const fullKey = `UAAS-${cleanNumber}`;

      console.log("Validando Test Execution:", fullKey);
      const validation = await validateTestExecution(
        xrayBaseUrl,
        token,
        fullKey
      );

      if (validation.valid) {
        console.log("Validação bem-sucedida:", validation);
        setTestExecutionKey(fullKey);
        setValidationResult(validation);

        const executingIds = new Set<string>();
        if (validation.testRuns?.results) {
          validation.testRuns.results.forEach((tr) => {
            const status = tr.status?.toUpperCase() || "";
            if (status === "EXECUTING" || status === "IN PROGRESS") {
              executingIds.add(tr.id);
            }
          });
        }
        setExecutingTestRunIds(executingIds);

        setFiles([]);
        setInvalidFiles([]);
        setIgnoredFiles([]);
        setGroupedFiles({});
        setExpandedTestRuns(new Set());
        setTestRunInfoMap(new Map());
        if (fileInputRef.current) {
          fileInputRef.current.value = "";
        }
        if (folderInputRef.current) {
          folderInputRef.current.value = "";
        }
      } else {
        console.log("Validação falhou:", validation);
        setTestExecutionKey("");
        setValidationResult(validation);
      }
    } catch (error: any) {
      console.error("Erro ao validar Test Execution:", error);
      setTestExecutionKey("");

      let errorMessage = error.message || "Erro ao validar Test Execution.";

      // Mensagens de erro mais específicas
      if (error.message?.includes("CORS")) {
        errorMessage =
          "Erro CORS: O servidor não permite requisições do frontend. Verifique a configuração do backend.";
      } else if (
        error.message?.includes("Failed to fetch") ||
        error.message?.includes("NetworkError")
      ) {
        errorMessage = `Erro de rede: Não foi possível conectar ao backend. Verifique se o backend está a correr em ${
          import.meta.env.VITE_BACKEND_URL || "a URL configurada"
        }.`;
      } else if (error.message?.includes("404")) {
        errorMessage =
          "Endpoint não encontrado. Verifique se a URL do backend está correta.";
      } else if (
        error.message?.includes("401") ||
        error.message?.includes("403")
      ) {
        errorMessage =
          "Erro de autenticação. Verifique as credenciais do Xray Cloud.";
      }

      setValidationResult({
        valid: false,
        error: errorMessage,
      });

      setResult({
        success: false,
        message: errorMessage,
      });
    } finally {
      setIsValidating(false);
    }
  };

  const handleTestExecutionNumberChange = (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    let number = e.target.value.replace(/^UAAS-?/i, "");
    number = number.replace(/[^0-9]/g, "");
    setTestExecutionNumber(number);
    setValidationResult(null);
    setTestExecutionKey("");
    setFiles([]);
    setInvalidFiles([]);
    setIgnoredFiles([]);
    setGroupedFiles({});
    setExecutingTestRunIds(new Set());
  };

  const handleValidateClick = () => {
    if (!testExecutionNumber.trim()) {
      setResult({
        success: false,
        message: "Por favor, introduza o número da Test Execution",
      });
      return;
    }

    // Verificar variáveis de ambiente antes de validar
    if (!xrayBaseUrl || !clientId || !clientSecret) {
      setResult({
        success: false,
        message:
          "As credenciais do Xray Cloud não estão configuradas. Verifique as variáveis de ambiente VITE_XRAY_BASE_URL, VITE_XRAY_CLIENT_ID e VITE_XRAY_CLIENT_SECRET.",
      });
      setValidationResult({
        valid: false,
        error: "Credenciais não configuradas",
      });
      console.error("Variáveis de ambiente não configuradas:", {
        xrayBaseUrl: xrayBaseUrl || "MISSING",
        clientId: clientId ? "SET" : "MISSING",
        clientSecret: clientSecret ? "SET" : "MISSING",
        backendUrl: import.meta.env.VITE_BACKEND_URL || "MISSING",
      });
      return;
    }

    validateTestExecutionKey(testExecutionNumber);
  };

  const handleImport = async () => {
    if (!testExecutionKey.trim() || !validationResult?.valid) {
      setResult({
        success: false,
        message:
          validationResult?.valid === false
            ? validationResult.error || "Test Execution inválida"
            : "Por favor, introduza e valide o ID da Test Execution",
      });
      return;
    }

    if (Object.keys(groupedFiles).length === 0) {
      setResult({
        success: false,
        message: "Por favor, faça upload de ficheiros válidos",
      });
      return;
    }

    if (!xrayBaseUrl || !clientId || !clientSecret) {
      setResult({
        success: false,
        message:
          "As credenciais do Xray Cloud não estão configuradas. Por favor, configure as variáveis de ambiente VITE_XRAY_BASE_URL, VITE_XRAY_CLIENT_ID e VITE_XRAY_CLIENT_SECRET no ficheiro .env.local",
      });
      return;
    }

    setIsProcessing(true);
    setResult(null);

    // Declare intervals outside try block so they're accessible in catch
    let messageInterval: NodeJS.Timeout | null = null;
    let animationInterval: NodeJS.Timeout | null = null;

    try {
      const token = await authenticateXray(xrayBaseUrl, clientId, clientSecret);

      const userStr = localStorage.getItem("user");
      let executedBy: string | undefined;
      if (userStr) {
        try {
          const user = JSON.parse(userStr);
          if (user.xrayAccountId) {
            executedBy = user.xrayAccountId;
          }
        } catch (e) {}
      }
      const testRunDataMap = new Map<
        string,
        {
          testRunNumber: string;
          testRunId?: string;
          testData: XrayTest;
          finishedOn: string;
          startedOn?: string;
        }
      >();
      const now = new Date();

      for (const [testRunNumber, fileGroup] of Object.entries(groupedFiles)) {
        const evidences: XrayEvidence[] = [];

        for (const fileWithTestRun of fileGroup) {
          const { base64, wasCompressed } = await fileToBase64(
            fileWithTestRun.file
          );
          evidences.push({
            data: base64,
            filename: fileWithTestRun.file.name,
            contentType: wasCompressed
              ? "image/jpeg"
              : getContentType(fileWithTestRun.file.name),
          });
        }

        const testRunInfo = testRunInfoMap.get(testRunNumber);
        const originalStart = testRunInfo?.startedOn;
        const testRunId = testRunInfo?.id;

        const status = "PASSED";
        const finish = now.toISOString();

        const testData: XrayTest = {
          testKey: `UAAS-${testRunNumber}`,
          status: status,
          start: originalStart || now.toISOString(),
          finish: finish,
          evidences,
        };

        testRunDataMap.set(testRunNumber, {
          testRunNumber,
          testRunId,
          testData,
          finishedOn: finish,
          startedOn: originalStart,
        });
      }

      const totalTestRuns = testRunDataMap.size;
      const completed: string[] = [];
      const failed: Array<{ testRun: string; error: string }> = [];

      // Batch size can be larger now that we compress images automatically
      // Images larger than 3MB are automatically compressed before upload
      const BATCH_SIZE = 10;
      const testRunEntries = Array.from(testRunDataMap.entries());
      const batches: Array<typeof testRunEntries> = [];

      for (let i = 0; i < testRunEntries.length; i += BATCH_SIZE) {
        batches.push(testRunEntries.slice(i, i + BATCH_SIZE));
      }

      const dynamicMessages = [
        "Testes a serem atualizados no Xray",
        "Pode demorar alguns segundos",
        "A processar evidências...",
        "A enviar ficheiros...",
        "A atualizar status...",
        "Quase terminado...",
      ];

      let messageIndex = 0;
      setProgress({
        current: 0,
        total: totalTestRuns,
        message: `${totalTestRuns} testes a serem atualizados`,
        stage: "rest",
        completed: [],
        inProgress: [],
        failed: [],
        animatedProgress: 0,
        dynamicMessage: dynamicMessages[0],
      });

      messageInterval = setInterval(() => {
        setProgress((prev) => {
          if (!prev || prev.stage === "complete") {
            if (messageInterval) clearInterval(messageInterval);
            return prev;
          }
          messageIndex = (messageIndex + 1) % dynamicMessages.length;
          return {
            ...prev,
            dynamicMessage: dynamicMessages[messageIndex],
          };
        });
      }, 4500);

      let animatedValue = 0;
      animationInterval = setInterval(() => {
        setProgress((prev) => {
          if (!prev || prev.stage === "complete") {
            if (animationInterval) clearInterval(animationInterval);
            return prev;
          }
          const realProgress = (prev.current / prev.total) * 100;
          if (animatedValue < realProgress - 5) {
            animatedValue = Math.max(
              animatedValue,
              Math.min(animatedValue + 2, realProgress - 5)
            );
          } else {
            animatedValue = Math.max(
              animatedValue,
              Math.min(animatedValue + 0.3, 95)
            );
          }
          return {
            ...prev,
            animatedProgress: Math.max(
              prev.animatedProgress || 0,
              animatedValue
            ),
          };
        });
      }, 200);

      for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
        const batch = batches[batchIdx];
        const batchTestRuns = batch.map(
          ([testRunNumber]) => `UAAS-${testRunNumber}`
        );

        const restProgress = (completed.length / totalTestRuns) * 100;
        setProgress((prev) =>
          prev
            ? {
                ...prev,
                current: completed.length,
                total: totalTestRuns,
                message: `${totalTestRuns} testes a serem atualizados`,
                stage: "rest",
                completed: [...completed],
                inProgress: [],
                failed: [...failed],
                animatedProgress: Math.max(
                  prev.animatedProgress || 0,
                  restProgress
                ),
              }
            : null
        );

        const batchTests: XrayTest[] = batch.map(([_, data]) => data.testData);
        const batchSuccessful: typeof batch = [];

        try {
          const importData: XrayImportRequest = {
            testExecutionKey: testExecutionKey.trim(),
            tests: batchTests,
          };

          // Calculate approximate payload size (base64 is ~33% larger)
          const payloadSize = JSON.stringify({
            xrayBaseUrl,
            token,
            importData,
          }).length;
          const payloadSizeMB = payloadSize / (1024 * 1024);

          // Warn if payload is getting large (Vercel limit is ~4.5MB for Pro)
          if (payloadSizeMB > 3) {
            console.warn(
              `Payload size: ${payloadSizeMB.toFixed(2)}MB for batch ${
                batchIdx + 1
              }`
            );
          }

          await importExecution(xrayBaseUrl, token, importData);

          batch.forEach((entry) => {
            batchSuccessful.push(entry);
          });
        } catch (error: any) {
          const errorMessage = error.message || "Falha ao enviar via REST API";

          // If it's a 413 or payload too large error, mark all in batch as failed
          // and provide clear error message
          batch.forEach(([testRunNumber]) => {
            failed.push({
              testRun: `UAAS-${testRunNumber}`,
              error:
                errorMessage.includes("413") ||
                errorMessage.includes("muito grande") ||
                errorMessage.includes("Payload muito grande")
                  ? `Payload muito grande: ${errorMessage}`
                  : errorMessage,
            });
          });

          // If it's a payload size error, stop processing remaining batches
          // to avoid wasting time on requests that will also fail
          if (
            errorMessage.includes("413") ||
            errorMessage.includes("muito grande") ||
            errorMessage.includes("Payload muito grande")
          ) {
            // Mark remaining batches as failed
            for (
              let remainingIdx = batchIdx + 1;
              remainingIdx < batches.length;
              remainingIdx++
            ) {
              batches[remainingIdx].forEach(([testRunNumber]) => {
                failed.push({
                  testRun: `UAAS-${testRunNumber}`,
                  error:
                    "Não processado: Batch anterior falhou devido a payload muito grande",
                });
              });
            }
            break; // Exit the batch loop
          }

          continue;
        }

        if (batchSuccessful.length > 0) {
          const statusUpdates: Array<{
            testRunId: string;
            status: string;
          }> = [];

          batchSuccessful.forEach(([_, data]) => {
            if (data.testRunId) {
              statusUpdates.push({
                testRunId: data.testRunId,
                status: "PASSED",
              });
            }
          });

          if (statusUpdates.length > 0) {
            const graphqlProgress = (completed.length / totalTestRuns) * 100;
            setProgress((prev) =>
              prev
                ? {
                    ...prev,
                    current: completed.length,
                    total: totalTestRuns,
                    message: `${totalTestRuns} testes a serem atualizados`,
                    stage: "graphql",
                    completed: [...completed],
                    inProgress: [],
                    failed: [...failed],
                    animatedProgress: Math.max(
                      prev.animatedProgress || 0,
                      graphqlProgress
                    ),
                  }
                : null
            );

            try {
              const graphqlResponse = await updateTestRunsViaGraphQL(
                xrayBaseUrl,
                token,
                statusUpdates
              );

              const graphqlErrors = graphqlResponse.errors || [];

              batchSuccessful.forEach(([testRunNumber, data]) => {
                const hasGraphQLError = graphqlErrors.some(
                  (error: any) => error.testRunId === data.testRunId
                );

                if (!hasGraphQLError) {
                  completed.push(`UAAS-${testRunNumber}`);
                } else {
                  const error = graphqlErrors.find(
                    (e: any) => e.testRunId === data.testRunId
                  );
                  failed.push({
                    testRun: `UAAS-${testRunNumber}`,
                    error: `Status não atualizado via GraphQL: ${
                      error?.error || "Erro desconhecido"
                    }`,
                  });
                }
              });
            } catch (graphqlError: any) {
              batchSuccessful.forEach(([testRunNumber]) => {
                failed.push({
                  testRun: `UAAS-${testRunNumber}`,
                  error: `GraphQL falhou: ${
                    graphqlError.message || "Erro desconhecido"
                  }`,
                });
              });
            }
          } else {
            batchSuccessful.forEach(([testRunNumber]) => {
              completed.push(`UAAS-${testRunNumber}`);
            });
          }
        }

        const batchProgress = (completed.length / totalTestRuns) * 100;
        setProgress((prev) =>
          prev
            ? {
                ...prev,
                current: completed.length,
                total: totalTestRuns,
                message: `${totalTestRuns} testes a serem atualizados`,
                stage: batchIdx < batches.length - 1 ? "rest" : "graphql",
                completed: [...completed],
                inProgress: [],
                failed: [...failed],
                animatedProgress: Math.max(
                  prev.animatedProgress || 0,
                  batchProgress
                ),
              }
            : null
        );
      }

      // Clear intervals before setting final progress
      if (messageInterval) clearInterval(messageInterval);
      if (animationInterval) clearInterval(animationInterval);

      const allSuccessful = failed.length === 0 && completed.length > 0;

      // Show detailed error message if all failed or if there were critical errors
      const hasPayloadErrors = failed.some(
        (f) =>
          f.error.includes("413") ||
          f.error.includes("muito grande") ||
          f.error.includes("Payload muito grande")
      );

      let resultMessage = "";
      if (allSuccessful) {
        resultMessage = `Importação realizada com sucesso! ${completed.length} test run(s) atualizado(s).`;
      } else if (hasPayloadErrors && completed.length === 0) {
        resultMessage = `Falha na importação: Payload muito grande. Os ficheiros são demasiado grandes para enviar. Tente fazer upload de menos ficheiros por vez ou use ficheiros menores.`;
      } else if (failed.length === totalTestRuns) {
        resultMessage = `Falha na importação: Nenhum teste foi atualizado. Verifique os erros abaixo.`;
      } else {
        resultMessage = `Importação parcial: ${completed.length} sucesso, ${failed.length} falha(s).`;
      }

      setProgress({
        current: completed.length,
        total: totalTestRuns,
        message: allSuccessful
          ? `${totalTestRuns} testes atualizados`
          : failed.length === totalTestRuns
          ? "Falha na importação"
          : `${completed.length} de ${totalTestRuns} testes atualizados`,
        stage: "complete",
        completed: [...completed],
        inProgress: [],
        failed: [...failed],
        animatedProgress: allSuccessful
          ? 100
          : (completed.length / totalTestRuns) * 100,
        dynamicMessage: "",
      });

      setResult({
        success: allSuccessful,
        message: resultMessage,
        details: {
          completed: completed.length,
          failed: failed.length,
          failures: failed.length > 0 ? failed : undefined,
        },
      });

      setFiles([]);
      setInvalidFiles([]);
      setIgnoredFiles([]);
      setGroupedFiles({});
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
      if (folderInputRef.current) {
        folderInputRef.current.value = "";
      }
    } catch (error: any) {
      // Clear progress modal on critical errors
      if (messageInterval) clearInterval(messageInterval);
      if (animationInterval) clearInterval(animationInterval);

      let errorMessage = error.message || "Erro ao importar evidências";

      // Provide more specific error messages
      if (errorMessage.includes("CORS")) {
        errorMessage =
          "Erro CORS: O servidor não permite requisições do frontend. Contacte o administrador do sistema.";
      } else if (
        errorMessage.includes("413") ||
        errorMessage.includes("muito grande")
      ) {
        errorMessage =
          "Payload muito grande: Os ficheiros são demasiado grandes para enviar de uma vez. Tente fazer upload de menos ficheiros por vez ou use ficheiros menores.";
      } else if (
        errorMessage.includes("504") ||
        errorMessage.includes("Timeout")
      ) {
        errorMessage =
          "Timeout do servidor: O processamento demorou demasiado tempo. Tente fazer upload de menos ficheiros por vez.";
      } else if (
        errorMessage.includes("Failed to fetch") ||
        errorMessage.includes("rede")
      ) {
        errorMessage =
          "Erro de rede: Não foi possível conectar ao servidor. Verifique a sua ligação à internet e tente novamente.";
      }

      setProgress(null);
      setResult({
        success: false,
        message: errorMessage,
        details: error,
      });
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div
      className={`min-h-screen transition-colors duration-200 ${
        isDarkMode
          ? "bg-gray-900 text-white"
          : "bg-gradient-to-br from-gray-50 to-gray-100 text-gray-900"
      }`}
    >
      <Header />
      <main className="max-w-7xl mx-auto px-4 py-12">
        <div className="text-center space-y-4 animate-fade-in mb-8">
          <p
            className={`text-xl ${
              isDarkMode ? "text-gray-300" : "text-gray-600"
            } animate-fade-in-up max-w-2xl mx-auto`}
          ></p>
        </div>

        <div className="max-w-6xl mx-auto px-4 py-8 space-y-6">
          <div className="max-w-4xl mx-auto space-y-6">
            {/* Test Execution Input */}
            <div
              className={`${
                isDarkMode ? "bg-gray-800" : "bg-white"
              } rounded-xl shadow-lg p-6`}
            >
              <h3
                className={`text-xl font-semibold mb-4 ${
                  isDarkMode ? "text-white" : "text-gray-900"
                }`}
              >
                Test Execution
              </h3>

              {/* Aviso se variáveis de ambiente não estão configuradas */}
              {(!xrayBaseUrl || !clientId || !clientSecret) && (
                <div className="mb-4 p-4 rounded-lg bg-red-900/20 border border-red-500/50">
                  <div className="flex items-start gap-2">
                    <span className="text-red-500 text-lg">⚠</span>
                    <div>
                      <p
                        className={`text-sm font-medium ${
                          isDarkMode ? "text-red-400" : "text-red-600"
                        }`}
                      >
                        Credenciais não configuradas
                      </p>
                      <p
                        className={`text-xs mt-1 ${
                          isDarkMode ? "text-red-300" : "text-red-700"
                        }`}
                      >
                        As variáveis de ambiente VITE_XRAY_BASE_URL,
                        VITE_XRAY_CLIENT_ID e VITE_XRAY_CLIENT_SECRET não estão
                        configuradas. O botão "Validar" não funcionará até que
                        estas variáveis sejam configuradas.
                      </p>
                      <p
                        className={`text-xs mt-2 font-mono ${
                          isDarkMode ? "text-red-200" : "text-red-800"
                        }`}
                      >
                        Backend URL:{" "}
                        {import.meta.env.VITE_BACKEND_URL || "NÃO CONFIGURADO"}
                      </p>
                    </div>
                  </div>
                </div>
              )}

              <div>
                <label
                  className={`block text-sm font-medium mb-2 ${
                    isDarkMode ? "text-gray-300" : "text-gray-700"
                  }`}
                >
                  Número da Test Execution
                </label>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none z-10">
                      <span
                        className={`text-base font-normal ${
                          isDarkMode ? "text-white" : "text-gray-900"
                        }`}
                        style={{ letterSpacing: "0.025em" }}
                      >
                        UAAS-
                      </span>
                    </div>
                    <input
                      type="text"
                      value={testExecutionNumber}
                      onChange={handleTestExecutionNumberChange}
                      onKeyDown={(e) => {
                        if (
                          e.key === "Enter" &&
                          !isValidating &&
                          testExecutionNumber.trim()
                        ) {
                          e.preventDefault();
                          handleValidateClick();
                        }
                      }}
                      placeholder="Test Execution Number"
                      disabled={isValidating}
                      className={`w-full pl-16 pr-4 py-2 rounded-lg border text-base ${
                        isDarkMode
                          ? "bg-gray-700 border-gray-600 text-white placeholder-gray-400"
                          : "bg-white border-gray-300 text-gray-900 placeholder-gray-500"
                      } ${
                        validationResult?.valid === false
                          ? "border-red-500"
                          : validationResult?.valid === true
                          ? "border-green-500"
                          : ""
                      } focus:outline-none focus:ring-2 focus:ring-yellow-500 disabled:opacity-50 select-text`}
                      style={{ userSelect: "text", WebkitUserSelect: "text" }}
                    />
                  </div>
                  <button
                    onClick={handleValidateClick}
                    disabled={
                      isValidating ||
                      !testExecutionNumber.trim() ||
                      !xrayBaseUrl ||
                      !clientId ||
                      !clientSecret
                    }
                    className={`px-6 py-2 rounded-lg font-medium transition-colors ${
                      isValidating ||
                      !testExecutionNumber.trim() ||
                      !xrayBaseUrl ||
                      !clientId ||
                      !clientSecret
                        ? isDarkMode
                          ? "bg-gray-700 text-gray-500 cursor-not-allowed"
                          : "bg-gray-300 text-gray-500 cursor-not-allowed"
                        : isDarkMode
                        ? "bg-green-600 text-white hover:bg-green-700"
                        : "bg-green-500 text-white hover:bg-green-600"
                    }`}
                  >
                    {isValidating ? (
                      <span className="flex items-center gap-2">
                        <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                        Validar...
                      </span>
                    ) : (
                      "Validar"
                    )}
                  </button>
                </div>
                {validationResult?.valid === true && !isValidating && (
                  <div className="mt-2 space-y-2">
                    <div className="flex items-center gap-2">
                      <span className="text-green-500 text-xl">✓</span>
                      <p
                        className={`text-sm font-semibold ${
                          isDarkMode ? "text-green-400" : "text-green-600"
                        }`}
                      >
                        Test Execution Válida
                      </p>
                    </div>
                    <div
                      className={`text-sm ml-7 ${
                        isDarkMode ? "text-gray-300" : "text-gray-700"
                      }`}
                    >
                      <p>
                        {validationResult.testExecution?.key}
                        {validationResult.testExecution?.summary && (
                          <> - {validationResult.testExecution.summary}</>
                        )}
                        {validationResult.testRuns && (
                          <span
                            className={`ml-2 ${
                              isDarkMode ? "text-gray-400" : "text-gray-500"
                            }`}
                          >
                            ({validationResult.testRuns.total} Test Runs)
                          </span>
                        )}
                      </p>
                    </div>
                    {validationResult.statusSummary && (
                      <div className="flex flex-wrap gap-3 ml-7">
                        {(() => {
                          const statusOrder: Record<string, number> = {
                            PASSED: 1,
                            EXECUTING: 2,
                            "IN PROGRESS": 2,
                            BLOCKED: 3,
                            FAILED: 4,
                            FAIL: 4,
                            "TO DO": 5,
                            TODO: 5,
                            "N/A": 6,
                            NA: 6,
                          };

                          const sortedStatuses = Object.entries(
                            validationResult.statusSummary
                          ).sort(([statusA], [statusB]) => {
                            const priorityA =
                              statusOrder[statusA.toUpperCase()] || 999;
                            const priorityB =
                              statusOrder[statusB.toUpperCase()] || 999;
                            return priorityA - priorityB;
                          });

                          return sortedStatuses.map(([status, count]) => {
                            let statusColor = "";
                            let bgColor = "";
                            const upperStatus = status.toUpperCase();
                            if (upperStatus === "PASSED") {
                              statusColor = isDarkMode
                                ? "text-green-400"
                                : "text-green-600";
                              bgColor = isDarkMode
                                ? "bg-green-900/30"
                                : "bg-green-50";
                            } else if (
                              upperStatus === "EXECUTING" ||
                              upperStatus === "IN PROGRESS"
                            ) {
                              statusColor = isDarkMode
                                ? "text-yellow-400"
                                : "text-yellow-600";
                              bgColor = isDarkMode
                                ? "bg-yellow-900/30"
                                : "bg-yellow-50";
                            } else if (
                              upperStatus === "TO DO" ||
                              upperStatus === "TODO"
                            ) {
                              statusColor = isDarkMode
                                ? "text-gray-300"
                                : "text-gray-500";
                              bgColor = isDarkMode
                                ? "bg-gray-700/80"
                                : "bg-gray-100";
                            } else if (
                              upperStatus === "N/A" ||
                              upperStatus === "NA"
                            ) {
                              statusColor = isDarkMode
                                ? "text-gray-400"
                                : "text-gray-600";
                              bgColor = isDarkMode
                                ? "bg-gray-700/30"
                                : "bg-gray-100";
                            } else if (upperStatus === "BLOCKED") {
                              statusColor = isDarkMode
                                ? "text-orange-400"
                                : "text-orange-600";
                              bgColor = isDarkMode
                                ? "bg-orange-900/30"
                                : "bg-orange-50";
                            } else if (
                              upperStatus === "FAILED" ||
                              upperStatus === "FAIL"
                            ) {
                              statusColor = isDarkMode
                                ? "text-red-400"
                                : "text-red-600";
                              bgColor = isDarkMode
                                ? "bg-red-900/30"
                                : "bg-red-50";
                            } else {
                              statusColor = isDarkMode
                                ? "text-gray-300"
                                : "text-gray-700";
                              bgColor = isDarkMode
                                ? "bg-gray-700/30"
                                : "bg-gray-100";
                            }

                            return (
                              <div
                                key={status}
                                className={`px-3 py-1 rounded-md text-xs font-medium ${statusColor} ${bgColor}`}
                              >
                                <span className="font-semibold">{status}:</span>{" "}
                                <span className="font-bold">{count}</span>
                              </div>
                            );
                          });
                        })()}
                      </div>
                    )}
                  </div>
                )}
                {validationResult?.valid === false && !isValidating && (
                  <div className="flex items-center gap-2 mt-2">
                    <span className="text-red-500 text-xl">✗</span>
                    <p
                      className={`text-sm ${
                        isDarkMode ? "text-red-400" : "text-red-600"
                      }`}
                    >
                      {validationResult.error ||
                        "Test Execution não encontrada"}
                    </p>
                  </div>
                )}
                {isValidating && (
                  <p
                    className={`mt-2 text-sm ${
                      isDarkMode ? "text-gray-400" : "text-gray-600"
                    }`}
                  >
                    A validar Test Execution...
                  </p>
                )}
              </div>
            </div>

            {/* File Upload Section */}
            <div
              className={`${
                isDarkMode ? "bg-gray-800" : "bg-white"
              } rounded-xl shadow-lg p-6`}
            >
              <h3
                className={`text-xl font-semibold mb-4 ${
                  isDarkMode ? "text-white" : "text-gray-900"
                }`}
              >
                Upload de Ficheiros
              </h3>

              {(() => {
                if (!validationResult?.valid) {
                  return (
                    <div className="mb-4 p-3 rounded-lg bg-red-900/20 border border-red-500/50">
                      <div className="flex items-start gap-2">
                        <span className="text-red-500 text-lg">⚠</span>
                        <div>
                          <p
                            className={`text-sm font-medium ${
                              isDarkMode ? "text-red-400" : "text-red-600"
                            }`}
                          >
                            Aviso: Test Execution não validada
                          </p>
                          <p
                            className={`text-xs mt-1 ${
                              isDarkMode ? "text-red-300" : "text-red-700"
                            }`}
                          >
                            Por favor, valide a Test Execution antes de fazer
                            upload de evidências.
                          </p>
                        </div>
                      </div>
                    </div>
                  );
                }

                if (validationResult?.valid) {
                  const executingCount =
                    validationResult.statusSummary?.["EXECUTING"] ||
                    validationResult.statusSummary?.["IN PROGRESS"] ||
                    0;
                  const hasExecutingTests = executingCount > 0;

                  if (!hasExecutingTests) {
                    return (
                      <div className="mb-4 p-3 rounded-lg bg-red-900/20 border border-red-500/50">
                        <div className="flex items-start gap-2">
                          <span className="text-red-500 text-lg">⚠</span>
                          <div>
                            <p
                              className={`text-sm font-medium ${
                                isDarkMode ? "text-red-400" : "text-red-600"
                              }`}
                            >
                              Erro: Não existem testes em EXECUTING
                            </p>
                            <p
                              className={`text-xs mt-1 ${
                                isDarkMode ? "text-red-300" : "text-red-700"
                              }`}
                            >
                              Apenas é possível fazer upload de evidências para
                              testes que já se encontram em estado EXECUTING.
                              Por favor, inicie a execução dos testes antes de
                              fazer upload.
                            </p>
                          </div>
                        </div>
                      </div>
                    );
                  }
                }

                return null;
              })()}

              <div className="space-y-4">
                {/* Upload Mode Toggle and Import Button */}
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center space-x-4">
                    <span
                      className={`text-sm font-medium ${
                        isDarkMode ? "text-gray-300" : "text-gray-700"
                      }`}
                    >
                      Modo de upload:
                    </span>
                    <div className="flex space-x-2">
                      <button
                        type="button"
                        onClick={() => setUploadMode("folder")}
                        className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                          uploadMode === "folder"
                            ? "bg-yellow-600 text-white"
                            : isDarkMode
                            ? "bg-gray-700 text-gray-300 hover:bg-gray-600"
                            : "bg-gray-200 text-gray-700 hover:bg-gray-300"
                        }`}
                      >
                        Pasta
                      </button>
                      <button
                        type="button"
                        onClick={() => setUploadMode("files")}
                        className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                          uploadMode === "files"
                            ? "bg-yellow-600 text-white"
                            : isDarkMode
                            ? "bg-gray-700 text-gray-300 hover:bg-gray-600"
                            : "bg-gray-200 text-gray-700 hover:bg-gray-300"
                        }`}
                      >
                        Ficheiros
                      </button>
                    </div>
                  </div>
                  <button
                    onClick={handleImport}
                    disabled={
                      isProcessing ||
                      isValidating ||
                      Object.keys(groupedFiles).length === 0 ||
                      !testExecutionKey.trim() ||
                      !validationResult?.valid ||
                      (validationResult?.valid &&
                        (validationResult.statusSummary?.["EXECUTING"] ||
                          validationResult.statusSummary?.["IN PROGRESS"] ||
                          0) === 0)
                    }
                    className={`px-6 py-2 rounded-lg font-medium transition-colors ${
                      isProcessing ||
                      isValidating ||
                      Object.keys(groupedFiles).length === 0 ||
                      !testExecutionKey.trim() ||
                      !validationResult?.valid ||
                      (validationResult?.valid &&
                        (validationResult.statusSummary?.["EXECUTING"] ||
                          validationResult.statusSummary?.["IN PROGRESS"] ||
                          0) === 0)
                        ? isDarkMode
                          ? "bg-gray-700 text-gray-500 cursor-not-allowed"
                          : "bg-gray-300 text-gray-500 cursor-not-allowed"
                        : isDarkMode
                        ? "bg-green-600 text-white hover:bg-green-700"
                        : "bg-green-500 text-white hover:bg-green-600"
                    }`}
                  >
                    {isProcessing ? "A importar..." : "Importar para o XRAY"}
                  </button>
                </div>

                {/* Hidden file inputs */}
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  onChange={handleFileChange}
                  className="hidden"
                />
                <input
                  ref={folderInputRef}
                  type="file"
                  {...({ webkitdirectory: "" } as any)}
                  multiple
                  onChange={handleFileChange}
                  className="hidden"
                />

                {/* Upload Button */}
                {(() => {
                  const isDisabled =
                    !validationResult?.valid ||
                    (validationResult?.valid &&
                      (validationResult.statusSummary?.["EXECUTING"] ||
                        validationResult.statusSummary?.["IN PROGRESS"] ||
                        0) === 0);

                  return (
                    <button
                      type="button"
                      onClick={handleUploadClick}
                      disabled={isDisabled}
                      className={`w-full px-6 py-4 rounded-lg border-2 border-dashed transition-all duration-200 ${
                        isDisabled
                          ? isDarkMode
                            ? "border-gray-700 bg-gray-800 opacity-50 cursor-not-allowed text-gray-500"
                            : "border-gray-300 bg-gray-100 opacity-50 cursor-not-allowed text-gray-400"
                          : isDarkMode
                          ? "border-gray-600 bg-gray-700 hover:border-yellow-500 hover:bg-gray-600 text-white"
                          : "border-gray-300 bg-gray-50 hover:border-yellow-500 hover:bg-yellow-50 text-gray-700"
                      }`}
                    >
                      <div className="flex flex-col items-center space-y-2">
                        <svg
                          className="w-8 h-8"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
                          />
                        </svg>
                        <span className="font-medium">
                          {uploadMode === "folder"
                            ? "Selecionar Pasta"
                            : "Selecionar Ficheiros"}
                        </span>
                        <span
                          className={`text-xs ${
                            isDarkMode ? "text-gray-400" : "text-gray-500"
                          }`}
                        >
                          {uploadMode === "folder"
                            ? "Selecione uma pasta para fazer upload de todos os ficheiros"
                            : "Selecione um ou mais ficheiros"}
                        </span>
                      </div>
                    </button>
                  );
                })()}

                <div className="relative inline-block group">
                  <div className="flex items-center gap-2 text-yellow-500 cursor-help">
                    <svg
                      className="w-5 h-5"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                      />
                    </svg>
                    <span className="text-sm font-medium">
                      Formatos de ficheiros aceites
                    </span>
                  </div>
                  <div className="absolute left-0 bottom-full mb-2 hidden group-hover:block z-50 w-80">
                    <div
                      className={`${
                        isDarkMode
                          ? "bg-gray-800 border-gray-700"
                          : "bg-white border-gray-300"
                      } border rounded-lg shadow-xl p-4`}
                    >
                      <div className="flex items-start gap-2 mb-3">
                        <svg
                          className={`w-5 h-5 flex-shrink-0 mt-0.5 ${
                            isDarkMode ? "text-yellow-400" : "text-yellow-600"
                          }`}
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                          />
                        </svg>
                        <div>
                          <p
                            className={`text-sm font-semibold mb-2 ${
                              isDarkMode ? "text-white" : "text-gray-900"
                            }`}
                          >
                            Formatos aceites:
                          </p>
                          <ul
                            className={`text-xs space-y-1.5 ${
                              isDarkMode ? "text-gray-300" : "text-gray-700"
                            }`}
                          >
                            <li className="flex items-start gap-2">
                              <span className="text-green-500 mt-1">✓</span>
                              <span>
                                <code
                                  className={`px-1.5 py-0.5 rounded ${
                                    isDarkMode
                                      ? "bg-gray-700 text-yellow-400"
                                      : "bg-gray-100 text-yellow-600"
                                  }`}
                                >
                                  UAAS-123.png
                                </code>
                              </span>
                            </li>
                            <li className="flex items-start gap-2">
                              <span className="text-green-500 mt-1">✓</span>
                              <span>
                                <code
                                  className={`px-1.5 py-0.5 rounded ${
                                    isDarkMode
                                      ? "bg-gray-700 text-yellow-400"
                                      : "bg-gray-100 text-yellow-600"
                                  }`}
                                >
                                  UAAS-123-screenshot.jpeg
                                </code>
                              </span>
                            </li>
                            <li className="flex items-start gap-2">
                              <span className="text-green-500 mt-1">✓</span>
                              <span>
                                <code
                                  className={`px-1.5 py-0.5 rounded ${
                                    isDarkMode
                                      ? "bg-gray-700 text-yellow-400"
                                      : "bg-gray-100 text-yellow-600"
                                  }`}
                                >
                                  123.mp4
                                </code>
                              </span>
                            </li>
                            <li className="flex items-start gap-2">
                              <span className="text-green-500 mt-1">✓</span>
                              <span>
                                <code
                                  className={`px-1.5 py-0.5 rounded ${
                                    isDarkMode
                                      ? "bg-gray-700 text-yellow-400"
                                      : "bg-gray-100 text-yellow-600"
                                  }`}
                                >
                                  123-evidence.mp3
                                </code>
                              </span>
                            </li>
                            <li className="flex items-start gap-2">
                              <span className="text-green-500 mt-1">✓</span>
                              <span>
                                <code
                                  className={`px-1.5 py-0.5 rounded ${
                                    isDarkMode
                                      ? "bg-gray-700 text-yellow-400"
                                      : "bg-gray-100 text-yellow-600"
                                  }`}
                                >
                                  UAAS-123-document.pdf
                                </code>
                              </span>
                            </li>
                          </ul>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Test Runs List - Show grouped by Test Run */}
                {(Object.keys(groupedFiles).length > 0 ||
                  ignoredFiles.length > 0) && (
                  <div className="mt-6 pt-6 border-t border-gray-600">
                    <div className="flex items-center justify-between mb-4">
                      <div className="flex items-center gap-3">
                        <h4
                          className={`text-xs font-semibold ${
                            isDarkMode ? "text-white" : "text-gray-900"
                          }`}
                        >
                          Testes Selecionados (
                          {Object.keys(groupedFiles).length} testes,{" "}
                          {files.length} ficheiros)
                        </h4>
                        {ignoredFiles.length > 0 && (
                          <span
                            className={`text-xs px-2 py-1 rounded ${
                              isDarkMode
                                ? "bg-red-900/50 text-red-300 border border-red-700"
                                : "bg-red-100 text-red-700 border border-red-300"
                            }`}
                          >
                            ⚠ {ignoredFiles.length} ignorado
                            {ignoredFiles.length !== 1 ? "s" : ""}
                          </span>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setFiles([]);
                          setInvalidFiles([]);
                          setIgnoredFiles([]);
                          setGroupedFiles({});
                          setExpandedTestRuns(new Set());
                          if (fileInputRef.current) {
                            fileInputRef.current.value = "";
                          }
                          if (folderInputRef.current) {
                            folderInputRef.current.value = "";
                          }
                        }}
                        className={`text-xs px-3 py-1 rounded ${
                          isDarkMode
                            ? "bg-red-600 hover:bg-red-700 text-white"
                            : "bg-red-100 hover:bg-red-200 text-red-700"
                        } transition-colors`}
                      >
                        Limpar todos
                      </button>
                    </div>
                    <div className="relative">
                      {/* Scrollbar indicator - always visible on the right */}
                      <div
                        className={`absolute right-0 top-0 bottom-0 w-3 ${
                          isDarkMode ? "bg-gray-600/30" : "bg-gray-300/30"
                        } rounded-r-lg pointer-events-none z-10`}
                        style={{
                          background: isDarkMode
                            ? "linear-gradient(to right, transparent 0%, rgba(75, 85, 99, 0.3) 100%)"
                            : "linear-gradient(to right, transparent 0%, rgba(209, 213, 219, 0.3) 100%)",
                        }}
                      />
                      <div
                        ref={(el) => {
                          if (el) {
                            const hasScroll = el.scrollHeight > el.clientHeight;
                            if (hasScroll) {
                              el.scrollTop = 1;
                              setTimeout(() => {
                                el.scrollTop = 0;
                              }, 10);
                            }
                          }
                        }}
                        className={`max-h-72 space-y-2 ${
                          isDarkMode ? "bg-gray-700" : "bg-gray-50"
                        } rounded-lg p-3 always-visible-scrollbar ${
                          !isDarkMode ? "light" : ""
                        }`}
                        style={{
                          overflowY: "scroll",
                          overflowX: "hidden",
                          scrollbarWidth: "thin",
                          scrollbarColor: isDarkMode
                            ? "#6b7280 #374151"
                            : "#9ca3af #f3f4f6",
                        }}
                      >
                        {/* Ignored Files Section - Show first */}
                        {ignoredFiles.length > 0 && (
                          <div
                            className={`${
                              isDarkMode
                                ? "bg-gray-800 border border-red-700/50"
                                : "bg-white border border-red-300"
                            } rounded-lg overflow-hidden`}
                          >
                            <div className="p-2">
                              <div className="flex items-center gap-2">
                                <svg
                                  className={`w-4 h-4 ${
                                    isDarkMode ? "text-red-400" : "text-red-600"
                                  }`}
                                  fill="none"
                                  stroke="currentColor"
                                  viewBox="0 0 24 24"
                                >
                                  <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z"
                                  />
                                </svg>
                                <span
                                  className={`text-xs font-semibold ${
                                    isDarkMode ? "text-red-400" : "text-red-600"
                                  }`}
                                >
                                  Ficheiros Ignorados ({ignoredFiles.length})
                                </span>
                              </div>
                              <div className="mt-2 space-y-1">
                                {ignoredFiles.map((ignoredFile, idx) => {
                                  const displayName =
                                    ignoredFile.file.name.split("/").pop() ||
                                    ignoredFile.file.name.split("\\").pop() ||
                                    ignoredFile.file.name;

                                  const getReasonIcon = () => {
                                    switch (ignoredFile.reason) {
                                      case "invalid_format":
                                        return "📝";
                                      case "test_not_found":
                                        return "🔍";
                                      case "test_not_executing":
                                        return "⏸️";
                                      case "file_too_large":
                                        return "📦";
                                      default:
                                        return "⚠️";
                                    }
                                  };

                                  return (
                                    <div
                                      key={idx}
                                      className={`flex items-center gap-2 p-1.5 rounded ${
                                        isDarkMode
                                          ? "bg-gray-900/50"
                                          : "bg-gray-50"
                                      }`}
                                    >
                                      <span className="text-xs">
                                        {getReasonIcon()}
                                      </span>
                                      <span
                                        className={`text-xs font-mono ${
                                          isDarkMode
                                            ? "text-gray-300"
                                            : "text-gray-700"
                                        }`}
                                      >
                                        {displayName}
                                        <span
                                          className={`ml-2 ${
                                            isDarkMode
                                              ? "text-red-400"
                                              : "text-red-600"
                                          }`}
                                        >
                                          ({ignoredFile.reasonText})
                                        </span>
                                      </span>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          </div>
                        )}

                        {/* Valid Test Runs */}
                        {Object.entries(groupedFiles).map(
                          ([testRunNumber, fileGroup]) => {
                            const isExpanded =
                              expandedTestRuns.has(testRunNumber);
                            return (
                              <div
                                key={testRunNumber}
                                className={`${
                                  isDarkMode
                                    ? "bg-gray-800 border border-green-600/50"
                                    : "bg-white border border-green-400/50"
                                } rounded-lg overflow-hidden`}
                              >
                                <button
                                  type="button"
                                  onClick={() => {
                                    const newExpanded = new Set(
                                      expandedTestRuns
                                    );
                                    if (isExpanded) {
                                      newExpanded.delete(testRunNumber);
                                    } else {
                                      newExpanded.add(testRunNumber);
                                    }
                                    setExpandedTestRuns(newExpanded);
                                  }}
                                  className={`w-full flex items-center justify-between p-2.5 hover:${
                                    isDarkMode ? "bg-gray-700" : "bg-gray-50"
                                  } transition-colors`}
                                >
                                  <div className="flex items-center gap-2.5">
                                    <svg
                                      className={`w-4 h-4 transition-transform ${
                                        isExpanded ? "rotate-90" : ""
                                      } ${
                                        isDarkMode
                                          ? "text-gray-400"
                                          : "text-gray-600"
                                      }`}
                                      fill="none"
                                      stroke="currentColor"
                                      viewBox="0 0 24 24"
                                    >
                                      <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        strokeWidth={2}
                                        d="M9 5l7 7-7 7"
                                      />
                                    </svg>
                                    <span
                                      className={`text-xs font-semibold ${
                                        isDarkMode
                                          ? "text-yellow-400"
                                          : "text-yellow-600"
                                      }`}
                                    >
                                      UAAS-{testRunNumber}
                                    </span>
                                    <span
                                      className={`text-xs ${
                                        isDarkMode
                                          ? "text-gray-400"
                                          : "text-gray-500"
                                      }`}
                                    >
                                      ({fileGroup.length} ficheiro
                                      {fileGroup.length !== 1 ? "s" : ""})
                                    </span>
                                  </div>
                                </button>
                                {isExpanded && (
                                  <div
                                    className={`border-t ${
                                      isDarkMode
                                        ? "border-gray-700"
                                        : "border-gray-200"
                                    } p-2.5 space-y-1`}
                                  >
                                    {fileGroup.map((item, idx) => (
                                      <div
                                        key={idx}
                                        className={`flex items-center gap-2 p-1.5 rounded ${
                                          isDarkMode
                                            ? "bg-gray-900/50"
                                            : "bg-gray-50"
                                        }`}
                                      >
                                        <svg
                                          className={`w-3.5 h-3.5 ${
                                            isDarkMode
                                              ? "text-green-400"
                                              : "text-green-600"
                                          }`}
                                          fill="none"
                                          stroke="currentColor"
                                          viewBox="0 0 24 24"
                                        >
                                          <path
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                            strokeWidth={2}
                                            d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                                          />
                                        </svg>
                                        <span
                                          className={`text-xs ${
                                            isDarkMode
                                              ? "text-gray-300"
                                              : "text-gray-700"
                                          }`}
                                        >
                                          {item.file.name}
                                        </span>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            );
                          }
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Import Button */}
            <div className="flex justify-end"></div>
            {Object.keys(groupedFiles).length === 0 && files.length > 0 && (
              <div
                className={`text-sm text-center ${
                  isDarkMode ? "text-yellow-400" : "text-yellow-600"
                }`}
              >
                ⚠ Nenhum ficheiro válido encontrado. Verifique se os nomes
                seguem o formato: UAAS-&lt;número&gt;.extensão,
                UAAS-&lt;número&gt;-qualquer_coisa.extensão,
                &lt;número&gt;.extensão ou
                &lt;número&gt;-qualquer_coisa.extensão
              </div>
            )}

            {/* Progress Modal */}
            {progress && (
              <div
                className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50"
                style={{
                  position: "fixed",
                  top: 0,
                  left: 0,
                  right: 0,
                  bottom: 0,
                  overflow: "hidden",
                  pointerEvents: "auto",
                }}
              >
                <div
                  className={`rounded-xl shadow-2xl p-6 w-96 ${
                    isDarkMode ? "bg-gray-800" : "bg-white"
                  }`}
                  style={{
                    position: "relative",
                    isolation: "isolate",
                  }}
                >
                  <div className="mb-4">
                    <div className="flex justify-between items-center mb-4 relative">
                      <h3
                        className={`text-lg font-semibold ${
                          isDarkMode ? "text-white" : "text-gray-900"
                        }`}
                      >
                        {progress.message}
                      </h3>
                      {progress.stage !== "complete" && (
                        <div className="animate-spin rounded-full h-5 w-5 border-2 border-orange-500 border-t-transparent"></div>
                      )}
                      {progress.stage === "complete" && (
                        <button
                          onClick={() => {
                            setProgress(null);
                            setFiles([]);
                            setInvalidFiles([]);
                            setIgnoredFiles([]);
                            setGroupedFiles({});
                            setTestExecutionKey("");
                            setTestExecutionNumber("");
                            setValidationResult(null);
                            setExecutingTestRunIds(new Set());
                            setResult(null);
                            setExpandedTestRuns(new Set());
                            setTestRunInfoMap(new Map());
                            if (fileInputRef.current) {
                              fileInputRef.current.value = "";
                            }
                            if (folderInputRef.current) {
                              folderInputRef.current.value = "";
                            }
                          }}
                          className={`w-6 h-6 flex items-center justify-center rounded-full hover:bg-opacity-20 transition-colors ${
                            isDarkMode
                              ? "text-red-400 hover:bg-red-600"
                              : "text-red-500 hover:bg-red-100"
                          }`}
                        >
                          <svg
                            className="w-5 h-5"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M6 18L18 6M6 6l12 12"
                            />
                          </svg>
                        </button>
                      )}
                    </div>
                    <div
                      className="w-full bg-gray-200 rounded-full h-4 overflow-hidden relative mb-3"
                      style={{ contain: "layout style paint" }}
                    >
                      <div
                        className={`h-full transition-all duration-500 ease-out ${
                          progress.stage === "complete"
                            ? "bg-green-500"
                            : "bg-orange-500"
                        }`}
                        style={{
                          width: `${Math.min(progress.animatedProgress, 100)}%`,
                          willChange: "width",
                          transform: "translateZ(0)",
                          backfaceVisibility: "hidden",
                        }}
                      />
                    </div>
                    {progress.stage !== "complete" &&
                      progress.dynamicMessage && (
                        <p
                          className={`text-sm text-center ${
                            isDarkMode ? "text-gray-400" : "text-gray-500"
                          }`}
                        >
                          {progress.dynamicMessage}
                        </p>
                      )}
                    {progress.stage === "complete" && testExecutionKey && (
                      <div className="text-center mt-2">
                        <a
                          href={`https://ecom4isi.atlassian.net/browse/${testExecutionKey}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className={`text-sm font-medium underline hover:no-underline transition-all ${
                            isDarkMode
                              ? "text-blue-400 hover:text-blue-300"
                              : "text-blue-600 hover:text-blue-700"
                          }`}
                        >
                          Ver Test Execution
                        </a>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
