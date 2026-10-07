import { courtApi } from "./api";
import type courtReducer from "./courtSlice";

export type CourtState = ReturnType<typeof courtReducer>;
export type ApiState = ReturnType<typeof courtApi.reducer>;

/** 应用根状态类型（独立定义，避免与 store 循环引用） */
export interface AppState {
  court: CourtState;
  [courtApi.reducerPath]: ApiState;
}
