import { createContext, useContext } from 'react';

/** Painel aberto pela recepção (agenda, balcão e comanda; sem o financeiro e as configurações). */
export const DeskContext = createContext(false);
export const useDesk = () => useContext(DeskContext);
