import { useState, useRef, useEffect } from "react";
import { useGenieChat, useGenieConfig } from "@/hooks/useGenie";
import type { GenieMessage } from "@/types/billing";

function formatTimestamp(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date);
}

function MessageBubble({ message }: { message: GenieMessage }) {
  const isUser = message.role === "user";
  const isPending = message.status === "pending";
  const isError = message.status === "error";

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[80%] rounded-lg px-4 py-3 ${
          isUser
            ? "text-white"
            : isError
              ? "bg-red-50 border border-red-200 text-gray-900"
              : "bg-gray-100 text-gray-900"
        }`}
        style={isUser ? { backgroundColor: '#FF3621' } : {}}
      >
        {isPending ? (
          <div className="flex items-center gap-2">
            <div className="flex gap-1">
              <div className="h-2 w-2 animate-pulse rounded-full bg-gray-400 [animation-delay:-0.4s]" />
              <div className="h-2 w-2 animate-pulse rounded-full bg-gray-400 [animation-delay:-0.2s]" />
              <div className="h-2 w-2 animate-pulse rounded-full bg-gray-400" />
            </div>
            <span className="text-sm text-gray-500">Thinking — this could take a minute...</span>
          </div>
        ) : (
          <>
            <p className="text-sm whitespace-pre-wrap">{message.content}</p>

            {/* SQL Query Display */}
            {message.sql && (
              <div className="mt-3 rounded bg-gray-800 p-3">
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-xs font-medium text-gray-500">SQL Query</span>
                  <button
                    onClick={() => navigator.clipboard.writeText(message.sql || "")}
                    className="text-xs text-blue-400 hover:text-blue-300"
                  >
                    Copy
                  </button>
                </div>
                <pre className="overflow-x-auto text-xs text-green-400">
                  <code>{message.sql}</code>
                </pre>
              </div>
            )}

            {/* Query Results Display */}
            {message.data && message.data.length > 0 && (
              <div className="mt-3 overflow-x-auto rounded border border-gray-200 bg-white">
                <table className="min-w-full divide-y divide-gray-200 text-xs">
                  <thead className="bg-gray-50">
                    <tr>
                      {Object.keys(message.data?.[0] || {}).map((key) => (
                        <th
                          key={key}
                          className="px-3 py-2 text-left font-medium text-gray-500"
                        >
                          {key}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200">
                    {message.data.slice(0, 10).map((row, idx) => (
                      <tr key={idx}>
                        {Object.values(row).map((val, vidx) => (
                          <td key={vidx} className="whitespace-nowrap px-3 py-2 text-gray-700">
                            {String(val ?? "")}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {message.data.length > 10 && (
                  <div className="bg-gray-50 px-3 py-2 text-xs text-gray-500">
                    Showing 10 of {message.data.length} rows
                  </div>
                )}
              </div>
            )}

            {/* Error Display */}
            {isError && message.error && (
              <p className="mt-2 text-xs text-red-600">{message.error}</p>
            )}
          </>
        )}

        <p className={`mt-1 text-xs ${isUser ? "text-blue-200" : "text-gray-500"}`}>
          {formatTimestamp(message.timestamp)}
        </p>
      </div>
    </div>
  );
}

export function GenieChatView() {
  const { messages, isLoading, sendMessage, clearChat } = useGenieChat();
  const { data: genieConfig } = useGenieConfig();
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (input.trim() && !isLoading) {
      sendMessage(input.trim());
      setInput("");
    }
  };

  const isConfigured = genieConfig?.configured !== false;

  return (
    <div className="flex h-[min(500px,60vh)] flex-col bg-white">
      {/* Config warning */}
      {!isConfigured && (
        <div className="mx-6 mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
          <div className="flex items-start gap-2">
            <svg className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.072 16.5c-.77.833.192 2.5 1.732 2.5z" />
            </svg>
            <div>
              <p className="text-sm font-medium text-amber-800">Genie is not configured</p>
              <p className="mt-0.5 text-xs text-amber-700">
                Set the <code className="rounded bg-amber-100 px-1 font-mono">GENIE_SPACE_ID</code> environment variable to enable natural language queries about your cost data.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      {messages.length > 0 && (
        <div className="flex items-center justify-end border-b border-gray-200 px-6 py-2">
          <button
            onClick={clearChat}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50"
          >
            Clear Chat
          </button>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <p className="mb-4 text-sm text-gray-600">
              Ask questions about your cost data in natural language
            </p>
            <div className="grid w-full max-w-2xl grid-cols-2 gap-2 text-left">
              {[
                "What are my top 5 most expensive workspaces?",
                "Show me daily spending trends",
                "Which SQL warehouses cost the most?",
                "What percentage comes from interactive compute?",
              ].map((suggestion, idx) => (
                <button
                  key={idx}
                  onClick={() => setInput(suggestion)}
                  className="rounded-lg border border-gray-200 px-3 py-2 text-left text-xs text-gray-700 hover:border-gray-300 hover:bg-gray-50"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {messages.map((message) => (
              <MessageBubble key={message.id} message={message} />
            ))}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* Input */}
      <form onSubmit={handleSubmit} className="border-t border-gray-200 px-6 py-4">
        <div className="flex gap-3">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask a question about your cost data..."
            disabled={isLoading}
            className="flex-1 rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:border-[#FF3621] focus:outline-none focus:ring-1 focus:ring-[#FF3621] disabled:bg-gray-50 disabled:text-gray-500"
            style={{
              borderColor: input ? '#FF3621' : undefined,
            }}
            onFocus={(e) => e.currentTarget.style.borderColor = '#FF3621'}
            onBlur={(e) => e.currentTarget.style.borderColor = input ? '#FF3621' : ''}
          />
          <button
            type="submit"
            disabled={!input.trim() || isLoading}
            className="rounded-lg px-5 py-2.5 text-sm font-medium text-white transition-colors"
            style={{
              backgroundColor: (!input.trim() || isLoading) ? '#FFA390' : '#FF3621'
            }}
            onMouseEnter={(e) => {
              if (!(!input.trim() || isLoading)) {
                e.currentTarget.style.backgroundColor = '#E02F1C';
              }
            }}
            onMouseLeave={(e) => {
              if (!(!input.trim() || isLoading)) {
                e.currentTarget.style.backgroundColor = '#FF3621';
              }
            }}
          >
            {isLoading ? (
              <svg className="h-5 w-5 animate-spin" viewBox="0 0 24 24">
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                  fill="none"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                />
              </svg>
            ) : (
              "Send"
            )}
          </button>
        </div>
      </form>
    </div>
  );
}
