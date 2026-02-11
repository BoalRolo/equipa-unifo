import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { authenticateUser } from "../utils/mockUsers";
import { useDarkMode } from "../contexts/DarkModeContext";
import { getUserSettings, updateUserSettings } from "../services/firebase";

export default function Login() {
  const [userId, setUserId] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const navigate = useNavigate();
  const { isDarkMode, initializeWithUserSettings } = useDarkMode();

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    // Only allow digits
    if (/^\d*$/.test(value)) {
      if (
        (name === "userId" && value.length <= 6) ||
        (name === "password" && value.length <= 8)
      ) {
        if (name === "userId") {
          setUserId(value);
        } else {
          setPassword(value);
        }
      }
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (userId.length !== 4 && userId.length !== 6) {
      setError("O ID do utilizador deve ter 4 ou 6 dígitos");
      return;
    }

    if (password.length !== 6 && password.length !== 8) {
      setError("A palavra-passe deve ter 6 ou 8 dígitos");
      return;
    }

    const user = authenticateUser(userId, password);
    if (user) {
      // Initialize user settings in Firebase if they don't exist
      const settings = await getUserSettings(userId);
      if (settings === null) {
        // If no settings exist, create them with the default dark mode from the mock user
        await updateUserSettings(userId, { darkMode: !!user.darkMode });
      }

      // Store user info and authentication state in localStorage
      localStorage.setItem("user", JSON.stringify({ ...user, userId }));
      localStorage.setItem("isAuthenticated", "true");

      // Initialize dark mode with user settings
      await initializeWithUserSettings(userId);

      // Navigate to home page
      navigate("/");
    } else {
      setError("ID do utilizador ou palavra-passe inválidos");
    }
  };

  return (
    <div
      className={`min-h-screen transition-colors duration-200 ${
        isDarkMode
          ? "bg-gray-900"
          : "bg-gradient-to-br from-blue-50 to-gray-100"
      } flex flex-col justify-center py-12 sm:px-6 lg:px-8`}
    >
      <div className="sm:mx-auto sm:w-full sm:max-w-md">
        <div className="flex justify-center">
          <img
            src="/equipa-unifo/octo.svg"
            alt="Octopus Logo"
            className="w-20 h-20 animate-bounce"
          />
        </div>
        <h2
          className={`mt-6 text-center text-4xl font-extrabold ${
            isDarkMode ? "text-white" : "text-gray-900"
          }`}
        >
          Equipa UNIFO
        </h2>
        <p
          className={`mt-2 text-center text-lg ${
            isDarkMode ? "text-gray-300" : "text-gray-600"
          }`}
        >
          Entre com as suas credenciais
        </p>
      </div>

      <div className="mt-8 sm:mx-auto sm:w-full sm:max-w-md">
        <div
          className={`${
            isDarkMode
              ? "bg-gray-800 border-gray-700"
              : "bg-white border-gray-100"
          } py-8 px-4 shadow-2xl sm:rounded-xl sm:px-10 border transition-colors duration-200`}
        >
          <form className="space-y-6" onSubmit={handleSubmit}>
            <div>
              <label
                htmlFor="userId"
                className={`block text-sm font-medium ${
                  isDarkMode ? "text-gray-300" : "text-gray-700"
                }`}
              >
                Código de operador
              </label>
              <div className="mt-1 relative rounded-md shadow-sm">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <svg
                    className={`h-5 w-5 ${
                      isDarkMode ? "text-gray-400" : "text-gray-400"
                    }`}
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 20 20"
                    fill="currentColor"
                  >
                    <path
                      fillRule="evenodd"
                      d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z"
                      clipRule="evenodd"
                    />
                  </svg>
                </div>
                <input
                  id="userId"
                  name="userId"
                  type="text"
                  inputMode="numeric"
                  pattern="\d*"
                  maxLength={6}
                  required
                  className={`appearance-none block w-full pl-10 pr-3 py-3 border ${
                    isDarkMode
                      ? "border-gray-600 bg-gray-700 text-white placeholder-gray-400"
                      : "border-gray-300 bg-white text-gray-900 placeholder-gray-400"
                  } rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-yellow-500 focus:border-yellow-500 text-lg transition-all duration-200`}
                  placeholder="4 ou 6 dígitos"
                  value={userId}
                  onChange={handleChange}
                />
              </div>
            </div>

            <div>
              <label
                htmlFor="password"
                className={`block text-sm font-medium ${
                  isDarkMode ? "text-gray-300" : "text-gray-700"
                }`}
              >
                Palavra-passe
              </label>
              <div className="mt-1 relative rounded-md shadow-sm">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <svg
                    className={`h-5 w-5 ${
                      isDarkMode ? "text-gray-400" : "text-gray-400"
                    }`}
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 20 20"
                    fill="currentColor"
                  >
                    <path
                      fillRule="evenodd"
                      d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z"
                      clipRule="evenodd"
                    />
                  </svg>
                </div>
                <input
                  id="password"
                  name="password"
                  type="password"
                  inputMode="numeric"
                  pattern="\d*"
                  maxLength={8}
                  required
                  autoComplete="current-password"
                  className={`appearance-none block w-full pl-10 pr-3 py-3 border ${
                    isDarkMode
                      ? "border-gray-600 bg-gray-700 text-white placeholder-gray-400"
                      : "border-gray-300 bg-white text-gray-900 placeholder-gray-400"
                  } rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-yellow-500 focus:border-yellow-500 text-lg transition-all duration-200`}
                  placeholder="6 ou 8 dígitos"
                  value={password}
                  onChange={handleChange}
                />
              </div>
            </div>

            {error && (
              <div
                className={`${
                  isDarkMode
                    ? "bg-red-900 border-red-700"
                    : "bg-red-50 border-red-400"
                } border-l-4 p-4 rounded-md`}
              >
                <div className="flex">
                  <div className="flex-shrink-0">
                    <svg
                      className="h-5 w-5 text-red-400"
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox="0 0 20 20"
                      fill="currentColor"
                    >
                      <path
                        fillRule="evenodd"
                        d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
                        clipRule="evenodd"
                      />
                    </svg>
                  </div>
                  <div className="ml-3">
                    <p
                      className={`text-sm ${
                        isDarkMode ? "text-red-300" : "text-red-700"
                      }`}
                    >
                      {error}
                    </p>
                  </div>
                </div>
              </div>
            )}

            <div>
              <button
                type="submit"
                className="w-full flex justify-center py-3 px-4 border border-transparent rounded-lg shadow-sm text-lg font-medium text-white bg-yellow-500 hover:bg-yellow-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-yellow-500 transform transition-all duration-200 hover:scale-105"
              >
                Entrar
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
