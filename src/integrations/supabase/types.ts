export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.15"
  }
  public: {
    Tables: {
      bot_events: {
        Row: {
          id: number
          level: string
          message: string
          meta: Json | null
          ts: string
          user_id: string
        }
        Insert: {
          id?: number
          level?: string
          message: string
          meta?: Json | null
          ts?: string
          user_id: string
        }
        Update: {
          id?: number
          level?: string
          message?: string
          meta?: Json | null
          ts?: string
          user_id?: string
        }
        Relationships: []
      }
      bot_settings: {
        Row: {
          ai_review_enabled: boolean
          bot_enabled: boolean
          daily_loss_pct: number
          kill_switch_engaged: boolean
          last_cycle_at: string | null
          last_cycle_note: string | null
          live_max_alloc_usd: number
          max_exposure_pct: number
          max_leverage: number
          max_positions: number
          min_confidence: number
          mode: string
          paper_equity: number
          position_size_pct: number
          scalp_enabled: boolean
          scalp_sl_pct: number
          scalp_tp_pct: number
          server_agent_enabled: boolean
          sl_atr_mult: number
          sl_fixed_pct: number
          sl_type: string
          strategy_mode: string
          tp_rr: number
          trail_activate_pct: number
          trail_dist_pct: number
          trailing_enabled: boolean
          updated_at: string
          user_id: string
        }
        Insert: {
          ai_review_enabled?: boolean
          bot_enabled?: boolean
          daily_loss_pct?: number
          kill_switch_engaged?: boolean
          last_cycle_at?: string | null
          last_cycle_note?: string | null
          live_max_alloc_usd?: number
          max_exposure_pct?: number
          max_leverage?: number
          max_positions?: number
          min_confidence?: number
          mode?: string
          paper_equity?: number
          position_size_pct?: number
          scalp_enabled?: boolean
          scalp_sl_pct?: number
          scalp_tp_pct?: number
          server_agent_enabled?: boolean
          sl_atr_mult?: number
          sl_fixed_pct?: number
          sl_type?: string
          strategy_mode?: string
          tp_rr?: number
          trail_activate_pct?: number
          trail_dist_pct?: number
          trailing_enabled?: boolean
          updated_at?: string
          user_id: string
        }
        Update: {
          ai_review_enabled?: boolean
          bot_enabled?: boolean
          daily_loss_pct?: number
          kill_switch_engaged?: boolean
          last_cycle_at?: string | null
          last_cycle_note?: string | null
          live_max_alloc_usd?: number
          max_exposure_pct?: number
          max_leverage?: number
          max_positions?: number
          min_confidence?: number
          mode?: string
          paper_equity?: number
          position_size_pct?: number
          scalp_enabled?: boolean
          scalp_sl_pct?: number
          scalp_tp_pct?: number
          server_agent_enabled?: boolean
          sl_atr_mult?: number
          sl_fixed_pct?: number
          sl_type?: string
          strategy_mode?: string
          tp_rr?: number
          trail_activate_pct?: number
          trail_dist_pct?: number
          trailing_enabled?: boolean
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      equity_snapshots: {
        Row: {
          equity: number
          id: number
          mode: string
          realized_pnl: number
          ts: string
          unrealized_pnl: number
          user_id: string
        }
        Insert: {
          equity: number
          id?: number
          mode?: string
          realized_pnl?: number
          ts?: string
          unrealized_pnl?: number
          user_id: string
        }
        Update: {
          equity?: number
          id?: number
          mode?: string
          realized_pnl?: number
          ts?: string
          unrealized_pnl?: number
          user_id?: string
        }
        Relationships: []
      }
      paper_positions: {
        Row: {
          closed_at: string | null
          coin: string
          confidence: number
          entry_price: number
          exit_price: number | null
          exit_reason: string | null
          id: string
          indicators: Json | null
          leverage: number
          notional: number
          opened_at: string
          pnl: number | null
          reason: string
          side: string
          size: number
          status: string
          stop_loss: number
          take_profit: number
          trail_high: number | null
          user_id: string
        }
        Insert: {
          closed_at?: string | null
          coin: string
          confidence: number
          entry_price: number
          exit_price?: number | null
          exit_reason?: string | null
          id?: string
          indicators?: Json | null
          leverage: number
          notional: number
          opened_at?: string
          pnl?: number | null
          reason: string
          side: string
          size: number
          status?: string
          stop_loss: number
          take_profit: number
          trail_high?: number | null
          user_id: string
        }
        Update: {
          closed_at?: string | null
          coin?: string
          confidence?: number
          entry_price?: number
          exit_price?: number | null
          exit_reason?: string | null
          id?: string
          indicators?: Json | null
          leverage?: number
          notional?: number
          opened_at?: string
          pnl?: number | null
          reason?: string
          side?: string
          size?: number
          status?: string
          stop_loss?: number
          take_profit?: number
          trail_high?: number | null
          user_id?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          created_at: string
          id: string
          updated_at: string
          wallet_address: string | null
        }
        Insert: {
          created_at?: string
          id: string
          updated_at?: string
          wallet_address?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          updated_at?: string
          wallet_address?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
