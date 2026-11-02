const ROUTES = {
  admin: 'admin.html',
  agent: 'agent.html',
  seller: 'seller.html',
  buyer: 'buyer.html'
};

async function redirectUserByRole() {
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) {
    window.location.href = 'index.html';
    return;
  }

  const { data: profile, error } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (error || !profile) {
    window.location.href = 'buyer.html';
    return;
  }

  if (profile.role === 'admin') {
    window.location.href = ROUTES.admin;
  } else if (profile.role === 'agent') {
    window.location.href = ROUTES.agent;
  } else if (profile.role === 'seller') {
    window.location.href = ROUTES.seller;
  } else {
    window.location.href = ROUTES.buyer;
  }
}
