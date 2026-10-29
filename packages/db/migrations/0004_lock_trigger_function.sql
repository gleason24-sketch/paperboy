-- The sign-up trigger function is only meant to run as a trigger; nobody should call it through the API.
revoke execute on function public.handle_new_user() from public, anon, authenticated;
