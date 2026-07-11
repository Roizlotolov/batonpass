# Stand-in for the real hermes-agent's agent/model_metadata.py, used only to
# exercise the "known context length" branch of the plugin's post_api_request
# handler without depending on an actual Hermes install being on PYTHONPATH.
def get_cached_context_length(model, base_url):
    if model == "known-model":
        return 100000
    return None
