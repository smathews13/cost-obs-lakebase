import { useState, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import type { GenieConfig, GenieMessage, GenieResponse } from "@/types/billing";

export function useGenieConfig() {
  return useQuery<GenieConfig>({
    queryKey: ["genie", "config"],
    queryFn: async () => {
      const response = await fetch("/api/genie/config");
      if (!response.ok) throw new Error("Failed to fetch Genie config");
      return response.json();
    },
    staleTime: Infinity,
  });
}

interface ChatState {
  messages: GenieMessage[];
  conversationId: string | null;
  isLoading: boolean;
}

export function useGenieChat() {
  const [state, setState] = useState<ChatState>({
    messages: [],
    conversationId: null,
    isLoading: false,
  });

  const sendMessage = useMutation({
    mutationFn: async (message: string): Promise<GenieResponse> => {
      const response = await fetch("/api/genie/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          conversation_id: state.conversationId,
        }),
      });

      if (!response.ok) {
        let errorMsg: string;
        try {
          const errorBody = await response.json();
          errorMsg = errorBody.detail || errorBody.error || JSON.stringify(errorBody);
        } catch {
          errorMsg = await response.text();
        }
        throw new Error(errorMsg);
      }

      return response.json();
    },
    onMutate: (message: string) => {
      // Add user message immediately
      const userMessage: GenieMessage = {
        id: `user-${Date.now()}`,
        role: "user",
        content: message,
        timestamp: new Date(),
      };

      // Add pending assistant message
      const pendingMessage: GenieMessage = {
        id: `assistant-${Date.now()}`,
        role: "assistant",
        content: "",
        timestamp: new Date(),
        status: "pending",
      };

      setState((prev) => ({
        ...prev,
        messages: [...prev.messages, userMessage, pendingMessage],
        isLoading: true,
      }));
    },
    onSuccess: (response: GenieResponse) => {
      setState((prev) => {
        const messages = [...prev.messages];
        // Update the last (pending) message with the response
        const lastIndex = messages.length - 1;
        if (lastIndex >= 0 && messages[lastIndex].status === "pending") {
          messages[lastIndex] = {
            ...messages[lastIndex],
            content: response.response || "",
            sql: response.sql || undefined,
            data: response.data || undefined,
            status: response.status === "completed" ? "completed" : "error",
            error: response.error || undefined,
          };
        }

        return {
          ...prev,
          messages,
          conversationId: response.conversation_id || prev.conversationId,
          isLoading: false,
        };
      });
    },
    onError: (error: Error) => {
      setState((prev) => {
        const messages = [...prev.messages];
        // Update the last (pending) message with error
        const lastIndex = messages.length - 1;
        if (lastIndex >= 0 && messages[lastIndex].status === "pending") {
          messages[lastIndex] = {
            ...messages[lastIndex],
            content: "Sorry, I encountered an error processing your request.",
            status: "error",
            error: error.message,
          };
        }

        return {
          ...prev,
          messages,
          isLoading: false,
        };
      });
    },
  });

  const clearChat = useCallback(() => {
    setState({
      messages: [],
      conversationId: null,
      isLoading: false,
    });
  }, []);

  return {
    messages: state.messages,
    conversationId: state.conversationId,
    isLoading: state.isLoading,
    sendMessage: sendMessage.mutate,
    clearChat,
  };
}
