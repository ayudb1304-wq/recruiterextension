<script lang="ts">
  import { S } from '../../../lib/strings';
  import { store } from '../store.svelte';

  let email = $state('');
  const valid = $derived(/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim()));

  function submit(event: SubmitEvent): void {
    event.preventDefault();
    if (!valid) return;
    store.send({ type: 'requestMagicLink', email: email.trim() });
  }
</script>

<form class="field" onsubmit={submit}>
  <h2>{S.signInTitle}</h2>
  <p class="hint">{S.signInBody}</p>

  {#if store.magicLinkSent}
    <div class="banner ok" role="status">{S.signInSent}</div>
  {:else}
    <label for="signin-email">Email</label>
    <input
      id="signin-email"
      type="email"
      autocomplete="email"
      placeholder={S.signInPlaceholder}
      bind:value={email}
      required
    />
    <button class="primary" type="submit" disabled={!valid}>{S.signInButton}</button>
  {/if}
</form>
