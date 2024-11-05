// userSlice.ts
import { createSlice, PayloadAction } from "@reduxjs/toolkit";

interface User {
  profilePicture: string;
  username: string;
  email: string;
  firstName: string;
  lastName: string;
  bio: string;
  location: string;
  joinDate: string;
  isVerified: boolean;
}

interface UserState {
  user: User | null;
  isLoading: boolean;
  error: string | null;
}

const initialState: UserState = {
  user: null,
  isLoading: false,
  error: null,
};

const userSlice = createSlice({
  name: "user",
  initialState,
  reducers: {
    setUser: (state, action: PayloadAction<User | null>) => {
      state.user = action.payload;
    },
    setLoading: (state, action: PayloadAction<boolean>) => {
      state.isLoading = action.payload;
    },
    setError: (state, action: PayloadAction<string | null>) => {
      state.error = action.payload;
    },
    updateUserProfile: (state, action: PayloadAction<Partial<User>>) => {
      if (state.user) {
        state.user = { ...state.user, ...action.payload };
      }
    },
    clearUser: (state) => {
      state.user = null;
      state.error = null;
    },
  },
});

export const { setUser, setLoading, setError, updateUserProfile, clearUser } =
  userSlice.actions;

export const selectUser = (state: { user: UserState }) => state.user.user;
export const selectIsLoading = (state: { user: UserState }) =>
  state.user.isLoading;
export const selectError = (state: { user: UserState }) => state.user.error;

export default userSlice.reducer;
