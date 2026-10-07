import { configureStore } from "@reduxjs/toolkit";
import { courtApi } from "./api";
import courtReducer from "./courtSlice";
import { loadCourtState, saveCourtState } from "./persistence";

const preloadedState = loadCourtState();

export const store = configureStore({
  reducer: { court: courtReducer, [courtApi.reducerPath]: courtApi.reducer },
  middleware: (getDefault) => getDefault().concat(courtApi.middleware),
  preloadedState
});

// 每次状态变更后持久化，保证暂存队列不丢
store.subscribe(() => {
  saveCourtState(store.getState());
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
